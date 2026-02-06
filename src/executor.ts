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
  /** Provider name (e.g., "moonshot", "openai") */
  provider?: string;
  /** Model to use (e.g., "claude-haiku-4-5") */
  model?: string;
  /** Tools to enable (if not specified, uses defaults) */
  tools?: string[];
  /** Custom system prompt to append */
  systemPrompt?: string;
  /** Shared context to prepend to task */
  context?: string;
  /** Thinking budget: number of tokens, or level like "low", "medium", "high" */
  thinking?: number | string;
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
 * Shows the most relevant argument for each tool type.
 */
function extractToolArgsPreview(
  toolName: string,
  args: Record<string, unknown>
): string {
  if (!args || typeof args !== "object") return "";

  // Tool-specific formatting for better context
  switch (toolName) {
    case "read":
      if (args.path) {
        const p = String(args.path);
        const shortPath = p.length > 50 ? "..." + p.slice(-47) : p;
        if (args.offset || args.limit) {
          return `${shortPath} [${args.offset || 1}-${(Number(args.offset) || 1) + (Number(args.limit) || 100)}]`;
        }
        return shortPath;
      }
      break;

    case "write":
      if (args.path) {
        const p = String(args.path);
        const shortPath = p.length > 40 ? "..." + p.slice(-37) : p;
        const size = args.content ? `(${String(args.content).length} chars)` : "";
        return `${shortPath} ${size}`;
      }
      break;

    case "edit":
      if (args.path) {
        const p = String(args.path);
        const shortPath = p.length > 50 ? "..." + p.slice(-47) : p;
        return shortPath;
      }
      break;

    case "bash":
      if (args.command) {
        const cmd = String(args.command);
        return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
      }
      break;

    case "grep":
    case "rg":
      if (args.pattern) {
        const pattern = String(args.pattern);
        const path = args.path ? ` in ${String(args.path)}` : "";
        const preview = pattern + path;
        return preview.length > 60 ? preview.slice(0, 57) + "..." : preview;
      }
      break;

    case "find":
      if (args.path) {
        const p = String(args.path);
        const name = args.name ? ` -name "${args.name}"` : "";
        const preview = p + name;
        return preview.length > 60 ? preview.slice(0, 57) + "..." : preview;
      }
      break;

    case "mcp":
      if (args.tool) return `tool: ${args.tool}`;
      if (args.search) return `search: ${args.search}`;
      if (args.server) return `server: ${args.server}`;
      break;

    case "subagent":
      if (args.task) {
        const t = String(args.task);
        return t.length > 50 ? t.slice(0, 47) + "..." : t;
      }
      if (args.agent) return `agent: ${args.agent}`;
      break;

    case "todo":
      if (args.action) {
        const action = String(args.action);
        if (args.title) return `${action}: ${String(args.title).slice(0, 40)}`;
        if (args.id) return `${action}: ${args.id}`;
        return action;
      }
      break;
  }

  // Fallback: try common keys
  const fallbackKeys = [
    "command",
    "path",
    "file",
    "pattern",
    "query",
    "url",
    "task",
    "prompt",
    "name",
    "action",
  ];

  for (const key of fallbackKeys) {
    if (args[key] && typeof args[key] === "string") {
      const value = args[key] as string;
      return value.length > 60 ? value.slice(0, 57) + "..." : value;
    }
  }

  // Last resort: show first string arg
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 0) {
      const preview = `${key}: ${value}`;
      return preview.length > 60 ? preview.slice(0, 57) + "..." : preview;
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
    provider,
    model,
    tools,
    systemPrompt,
    context,
    thinking,
    id,
    name,
    step,
    signal,
    onProgress,
  } = options;

  const startTime = Date.now();
  const messages: Message[] = [];
  let stderr = "";
  let apiError = "";

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

  if (provider) {
    args.push("--provider", provider);
  }

  if (model) {
    args.push("--model", model);
  }

  if (tools && tools.length > 0) {
    args.push("--tools", tools.join(","));
  }

  // Handle thinking budget
  if (thinking !== undefined) {
    args.push("--thinking", String(thinking));
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

            // Detect API/auth errors
            const rawMsg = event.message as Record<string, unknown>;
            if (rawMsg.stopReason === "error" && rawMsg.errorMessage) {
              apiError = String(rawMsg.errorMessage);
            }

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
          progress.currentToolArgs = extractToolArgsPreview(
            event.toolName || "",
            event.args || {}
          );
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

    // Detect API errors even with exit code 0 (pi exits 0 on auth failures)
    if (apiError && !result.error) {
      result.error = apiError;
      result.exitCode = 1;
    }

    // Update final progress
    progress.status = result.aborted
      ? "aborted"
      : result.exitCode === 0
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
