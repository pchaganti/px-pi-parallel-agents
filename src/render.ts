/**
 * TUI rendering for the parallel agents tool.
 */

import * as os from "node:os";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import type {
  ParallelToolDetails,
  TaskProgress,
  TaskResult,
  UsageStats,
  ParallelParams,
} from "./types.js";
import { COLLAPSED_ITEM_COUNT } from "./types.js";

// ============================================================================
// Formatting Utilities
// ============================================================================

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m${secs}s`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];

  if (usage.turns) {
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  }
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);

  return parts.join(" ");
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(
  toolName: string,
  args: string,
  theme: { fg: (color: string, text: string) => string }
): string {
  // Simple formatting - just show tool name and args preview
  return theme.fg("muted", "→ ") + theme.fg("accent", toolName) + " " + theme.fg("dim", args);
}

function getStatusIcon(
  status: TaskProgress["status"],
  theme: Theme
): string {
  switch (status) {
    case "pending":
      return theme.fg("dim", "○");
    case "running":
      return theme.fg("warning", "⏳");
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "aborted":
      return theme.fg("warning", "⊘");
  }
}

// ============================================================================
// Render Call
// ============================================================================

export function renderCall(args: ParallelParams, theme: Theme): Text {
  // Chain mode
  if (args.chain && args.chain.length > 0) {
    let text =
      theme.fg("toolTitle", theme.bold("parallel ")) +
      theme.fg("accent", `chain (${args.chain.length} steps)`);

    for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
      const step = args.chain[i];
      const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
      const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
      const modelInfo = step.model ? theme.fg("muted", ` [${step.model}]`) : "";
      text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("dim", preview)}${modelInfo}`;
    }

    if (args.chain.length > 3) {
      text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
    }

    return new Text(text, 0, 0);
  }

  // Race mode
  if (args.race) {
    const preview =
      args.race.task.length > 50
        ? `${args.race.task.slice(0, 50)}...`
        : args.race.task;
    let text =
      theme.fg("toolTitle", theme.bold("parallel ")) +
      theme.fg("accent", `race (${args.race.models.length} models)`);
    text += `\n  ${theme.fg("dim", preview)}`;
    text += `\n  ${theme.fg("muted", args.race.models.join(" vs "))}`;
    return new Text(text, 0, 0);
  }

  // Parallel mode
  if (args.tasks && args.tasks.length > 0) {
    let text =
      theme.fg("toolTitle", theme.bold("parallel ")) +
      theme.fg("accent", `${args.tasks.length} tasks`);

    if (args.context) {
      const ctxPreview =
        args.context.length > 50 ? `${args.context.slice(0, 50)}...` : args.context;
      text += `\n  ${theme.fg("muted", "context:")} ${theme.fg("dim", ctxPreview)}`;
    }

    for (const t of args.tasks.slice(0, 3)) {
      const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
      const modelInfo = t.model ? theme.fg("muted", ` [${t.model}]`) : "";
      const nameInfo = t.name ? theme.fg("accent", `${t.name}: `) : "";
      text += `\n  ${nameInfo}${theme.fg("dim", preview)}${modelInfo}`;
    }

    if (args.tasks.length > 3) {
      text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
    }

    return new Text(text, 0, 0);
  }

  // Single mode
  const taskPreview = args.task
    ? args.task.length > 60
      ? `${args.task.slice(0, 60)}...`
      : args.task
    : "...";
  const modelInfo = args.model ? theme.fg("muted", ` [${args.model}]`) : "";
  let text =
    theme.fg("toolTitle", theme.bold("parallel ")) +
    theme.fg("accent", "single") +
    modelInfo;
  text += `\n  ${theme.fg("dim", taskPreview)}`;

  return new Text(text, 0, 0);
}

// ============================================================================
// Render Result
// ============================================================================

function renderTaskResult(
  result: TaskResult,
  expanded: boolean,
  theme: Theme
): string {
  const icon =
    result.aborted
      ? theme.fg("warning", "⊘")
      : result.exitCode === 0
        ? theme.fg("success", "✓")
        : theme.fg("error", "✗");

  const nameDisplay = result.name || result.id;
  const modelInfo = result.model ? theme.fg("muted", ` [${result.model}]`) : "";
  const stepInfo = result.step !== undefined ? theme.fg("muted", `Step ${result.step}: `) : "";

  let text = `${icon} ${stepInfo}${theme.fg("toolTitle", nameDisplay)}${modelInfo}`;

  if (result.error) {
    text += `\n${theme.fg("error", `Error: ${result.error}`)}`;
  }

  // Show output preview
  const outputLines = result.output.trim().split("\n");
  const displayLines = expanded ? outputLines : outputLines.slice(0, 5);

  if (displayLines.length > 0 && displayLines[0]) {
    text += "\n" + displayLines.map((l) => theme.fg("dim", l)).join("\n");
  }

  if (!expanded && outputLines.length > 5) {
    text += `\n${theme.fg("muted", `... ${outputLines.length - 5} more lines`)}`;
  }

  // Usage stats
  const usageStr = formatUsageStats(result.usage, result.model);
  if (usageStr) {
    text += `\n${theme.fg("dim", usageStr)}`;
  }

  return text;
}

function renderProgress(progress: TaskProgress, theme: Theme): string {
  const icon = getStatusIcon(progress.status, theme);
  const nameDisplay = progress.name || progress.id;
  const modelInfo = progress.model ? theme.fg("muted", ` [${progress.model}]`) : "";

  let text = `${icon} ${theme.fg("toolTitle", nameDisplay)}${modelInfo}`;

  if (progress.currentTool) {
    text += `\n  ${theme.fg("muted", "→")} ${theme.fg("accent", progress.currentTool)}`;
    if (progress.currentToolArgs) {
      text += ` ${theme.fg("dim", progress.currentToolArgs)}`;
    }
  }

  // Recent tools
  for (const tool of progress.recentTools.slice(-3)) {
    text += `\n  ${theme.fg("dim", "→")} ${theme.fg("muted", tool.tool)} ${theme.fg("dim", tool.args)}`;
  }

  return text;
}

export function renderResult(
  result: { content: Array<{ type: string; text?: string }>; details?: ParallelToolDetails },
  options: { expanded: boolean; isPartial?: boolean },
  theme: Theme
): Container | Text {
  const { expanded, isPartial } = options;
  const details = result.details;

  if (!details) {
    const text = result.content[0];
    return new Text(text?.type === "text" && text.text ? text.text : "(no output)", 0, 0);
  }

  // During execution - show progress
  if (isPartial && details.progress) {
    const running = details.progress.filter((p) => p.status === "running").length;
    const completed = details.progress.filter((p) => p.status === "completed").length;
    const total = details.progress.length;

    let text =
      theme.fg("warning", "⏳ ") +
      theme.fg("toolTitle", theme.bold("parallel ")) +
      theme.fg("accent", `${completed}/${total} done, ${running} running`);

    for (const prog of details.progress) {
      text += `\n\n${renderProgress(prog, theme)}`;
    }

    return new Text(text, 0, 0);
  }

  // Final results
  const container = new Container();
  const results = details.results;

  if (results.length === 0) {
    return new Text(theme.fg("muted", "(no results)"), 0, 0);
  }

  // Single result
  if (details.mode === "single" && results.length === 1) {
    return new Text(renderTaskResult(results[0], expanded, theme), 0, 0);
  }

  // Chain mode
  if (details.mode === "chain") {
    const successCount = results.filter((r) => r.exitCode === 0).length;
    const icon =
      successCount === results.length
        ? theme.fg("success", "✓")
        : theme.fg("error", "✗");

    let text =
      icon +
      " " +
      theme.fg("toolTitle", theme.bold("chain ")) +
      theme.fg("accent", `${successCount}/${results.length} steps`);

    for (const r of results) {
      text += `\n\n${renderTaskResult(r, expanded, theme)}`;
    }

    // Total usage
    const totalUsage = formatUsageStats(details.usage);
    if (totalUsage) {
      text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
    }

    text += `\n${theme.fg("dim", formatDuration(details.totalDurationMs))}`;

    return new Text(text, 0, 0);
  }

  // Race mode
  if (details.mode === "race") {
    const winner = results.find((r) => r.id === details.winner);
    const icon = winner ? theme.fg("success", "✓") : theme.fg("error", "✗");

    let text =
      icon +
      " " +
      theme.fg("toolTitle", theme.bold("race ")) +
      theme.fg("accent", `winner: ${details.winner || "none"}`);

    if (winner) {
      text += `\n\n${renderTaskResult(winner, expanded, theme)}`;
    }

    if (expanded) {
      text += `\n\n${theme.fg("muted", "Other contestants:")}`;
      for (const r of results.filter((r) => r.id !== details.winner)) {
        const rIcon = r.aborted
          ? theme.fg("warning", "⊘")
          : r.exitCode === 0
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");
        text += `\n  ${rIcon} ${theme.fg("muted", r.name || r.id)} ${theme.fg("dim", formatDuration(r.durationMs))}`;
      }
    }

    text += `\n\n${theme.fg("dim", formatDuration(details.totalDurationMs))}`;

    return new Text(text, 0, 0);
  }

  // Parallel mode
  const successCount = results.filter((r) => r.exitCode === 0).length;
  const icon =
    successCount === results.length
      ? theme.fg("success", "✓")
      : successCount > 0
        ? theme.fg("warning", "◐")
        : theme.fg("error", "✗");

  let text =
    icon +
    " " +
    theme.fg("toolTitle", theme.bold("parallel ")) +
    theme.fg("accent", `${successCount}/${results.length} succeeded`);

  const displayResults = expanded ? results : results.slice(0, COLLAPSED_ITEM_COUNT);
  for (const r of displayResults) {
    text += `\n\n${renderTaskResult(r, expanded, theme)}`;
  }

  if (!expanded && results.length > COLLAPSED_ITEM_COUNT) {
    text += `\n\n${theme.fg("muted", `... +${results.length - COLLAPSED_ITEM_COUNT} more (Ctrl+O to expand)`)}`;
  }

  // Total usage
  const totalUsage = formatUsageStats(details.usage);
  if (totalUsage) {
    text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
  }

  text += `\n${theme.fg("dim", formatDuration(details.totalDurationMs))}`;

  return new Text(text, 0, 0);
}
