/**
 * Subprocess executor for running pi agents.
 *
 * Spawns `pi` processes with JSON mode to capture structured output.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import {
  type TaskProgress,
  type TaskResult,
  type UsageStats,
  createEmptyUsage,
  addUsage,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
} from "./types.js";

/** Options for running a single agent task */
export interface ExecutorOptions {
  /** Task description/prompt */
  task: string;
  /** Working directory */
  cwd: string;
  /** Model to use (e.g., "claude-haiku-4-5") */
  model?: string;
  /** Tools to enable (if not specified, uses defaults) */
  tools?: string[];
  /** Custom system prompt to append */
  systemPrompt?: string;
  /** Shared context to prepend to task */
  context?: string;
  /** Unique identifier for this task */
  id: string;
  /** Display name */
  name?: string;
  /** Step number for chain mode */
  step?: number;
  /** Abort signal */
  signal?: AbortSignal;
  /** Progress callback */
  onProgress?: (progress: TaskProgress) => void;
}

/**
 * Extract final text output from messages.
 */
function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

/**
 * Truncate output to fit within limits.
 */
function truncateOutput(
  output: string,
  maxBytes: number = MAX_OUTPUT_BYTES,
  maxLines: number = MAX_OUTPUT_LINES
): { output: string; truncated: boolean } {
  const lines = output.split("\n");
  let truncated = false;

  // Truncate by lines
  if (lines.length > maxLines) {
    lines.splice(0, lines.length - maxLines);
    truncated = true;
  }

  let result = lines.join("\n");

  // Truncate by bytes
  if (Buffer.byteLength(result, "utf-8") > maxBytes) {
    while (Buffer.byteLength(result, "utf-8") > maxBytes && result.length > 0) {
      result = result.slice(Math.floor(result.length / 2));
    }
    truncated = true;
  }

  return { output: result, truncated };
}

/**
 * Write system prompt to a temp file.
 */
function writePromptToTempFile(
  id: string,
  prompt: string
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-"));
  const safeName = id.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

/**
 * Extract tool call preview for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
  const previewKeys = [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "task",
    "prompt",
  ];

  for (const key of previewKeys) {
    if (args[key] && typeof args[key] === "string") {
      const value = args[key] as string;
      return value.length > 60 ? `${value.slice(0, 57)}...` : value;
    }
  }

  return "";
}

/**
 * Run a single agent task in a subprocess.
 */
export async function runAgent(options: ExecutorOptions): Promise<TaskResult> {
  const {
    task,
    cwd,
    model,
    tools,
    systemPrompt,
    context,
    id,
    name,
    step,
    signal,
    onProgress,
  } = options;

  const startTime = Date.now();
  const messages: Message[] = [];
  let stderr = "";

  // Build progress state
  const progress: TaskProgress = {
    id,
    name,
    status: "running",
    task,
    model,
    recentTools: [],
    recentOutput: [],
    toolCount: 0,
    tokens: 0,
    durationMs: 0,
  };

  const usage: UsageStats = createEmptyUsage();

  const emitProgress = () => {
    progress.durationMs = Date.now() - startTime;
    onProgress?.({ ...progress });
  };

  // Build command args
  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  if (model) {
    args.push("--model", model);
  }

  if (tools && tools.length > 0) {
    args.push("--tools", tools.join(","));
  }

  // Handle system prompt
  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  try {
    if (systemPrompt?.trim()) {
      const tmp = writePromptToTempFile(id, systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    // Build the full prompt
    const fullTask = context ? `${context}\n\nTask: ${task}` : `Task: ${task}`;
    args.push(fullTask);

    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        // Handle message_end events
        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          messages.push(msg);

          if (msg.role === "assistant") {
            usage.turns++;
            const msgUsage = msg.usage;
            if (msgUsage) {
              addUsage(usage, {
                input: msgUsage.input || 0,
                output: msgUsage.output || 0,
                cacheRead: msgUsage.cacheRead || 0,
                cacheWrite: msgUsage.cacheWrite || 0,
                cost: msgUsage.cost?.total || 0,
                contextTokens: msgUsage.totalTokens || 0,
              });
            }

            // Extract text for recent output
            for (const part of msg.content) {
              if (part.type === "text" && part.text.trim()) {
                const preview =
                  part.text.length > 100
                    ? part.text.slice(0, 100) + "..."
                    : part.text;
                progress.recentOutput.push(preview);
                if (progress.recentOutput.length > 5) {
                  progress.recentOutput.shift();
                }
              }
            }

            emitProgress();
          }
        }

        // Handle tool execution events
        if (event.type === "tool_execution_start") {
          progress.currentTool = event.toolName;
          progress.currentToolArgs = extractToolArgsPreview(event.input || {});
          emitProgress();
        }

        if (event.type === "tool_execution_end") {
          if (progress.currentTool) {
            progress.recentTools.push({
              tool: progress.currentTool,
              args: progress.currentToolArgs || "",
            });
            if (progress.recentTools.length > 10) {
              progress.recentTools.shift();
            }
            progress.toolCount++;
          }
          progress.currentTool = undefined;
          progress.currentToolArgs = undefined;
          emitProgress();
        }

        // Handle tool_result_end
        if (event.type === "tool_result_end" && event.message) {
          messages.push(event.message as Message);
          emitProgress();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          processLine(line);
        }
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) {
          processLine(buffer);
        }
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      // Handle abort
      if (signal) {
        const killProc = () => {
          wasAborted = true;
          progress.status = "aborted";
          emitProgress();
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill("SIGKILL");
            }
          }, 5000);
        };

        if (signal.aborted) {
          killProc();
        } else {
          signal.addEventListener("abort", killProc, { once: true });
        }
      }
    });

    const finalOutput = getFinalOutput(messages);
    const { output: truncatedOutput, truncated } = truncateOutput(finalOutput);

    const result: TaskResult = {
      id,
      name,
      task,
      model,
      exitCode,
      output: truncatedOutput,
      stderr,
      truncated,
      durationMs: Date.now() - startTime,
      usage,
      step,
      aborted: progress.status === "aborted",
    };

    if (exitCode !== 0 && !result.aborted) {
      result.error = stderr || `Exit code: ${exitCode}`;
    }

    // Update final progress
    progress.status = result.aborted
      ? "aborted"
      : exitCode === 0
        ? "completed"
        : "failed";
    progress.durationMs = result.durationMs;
    onProgress?.(progress);

    return result;
  } finally {
    // Cleanup temp files
    if (tmpPromptPath) {
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    }
    if (tmpPromptDir) {
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
    }
  }
}
