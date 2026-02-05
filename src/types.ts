/**
 * Type definitions and Typebox schemas for the parallel agents tool.
 */

import { Type, type Static } from "@sinclair/typebox";

// ============================================================================
// Usage & Stats Types
// ============================================================================

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export function createEmptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

export function addUsage(target: UsageStats, source: Partial<UsageStats>): void {
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.cost += source.cost ?? 0;
  target.contextTokens = source.contextTokens ?? target.contextTokens;
  target.turns += source.turns ?? 0;
}

// ============================================================================
// Result Types
// ============================================================================

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** Progress tracking for a running task */
export interface TaskProgress {
  id: string;
  name?: string;
  status: TaskStatus;
  task: string;
  model?: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentTools: Array<{ tool: string; args: string }>;
  recentOutput: string[];
  toolCount: number;
  tokens: number;
  durationMs: number;
}

/** Final result from a single task execution */
export interface TaskResult {
  id: string;
  name?: string;
  task: string;
  model?: string;
  exitCode: number;
  output: string;
  fullOutputPath?: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  usage: UsageStats;
  error?: string;
  aborted?: boolean;
  step?: number; // For chain mode
}

/** Tool details stored in session for persistence */
export interface ParallelToolDetails {
  mode: "single" | "parallel" | "chain" | "race";
  results: TaskResult[];
  totalDurationMs: number;
  usage: UsageStats;
  progress?: TaskProgress[];
  winner?: string; // For race mode - the winning task id
}

// ============================================================================
// Typebox Schemas
// ============================================================================

/** Schema for a single task item in parallel mode */
export const TaskItemSchema = Type.Object({
  task: Type.String({ description: "Task to execute" }),
  name: Type.Optional(Type.String({ description: "Display name for this task" })),
  model: Type.Optional(
    Type.String({
      description: 'Model to use (e.g., "claude-haiku-4-5", "gpt-4o-mini")',
    })
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Restrict to specific tools (e.g., [\"read\", \"grep\", \"find\"])",
    })
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Override system prompt for this task" })
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
});

export type TaskItem = Static<typeof TaskItemSchema>;

/** Schema for a chain step */
export const ChainStepSchema = Type.Object({
  task: Type.String({
    description: "Task with optional {previous} placeholder for prior output",
  }),
  model: Type.Optional(Type.String({ description: "Model to use for this step" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Restrict tools" })),
  systemPrompt: Type.Optional(Type.String({ description: "Override system prompt" })),
});

export type ChainStep = Static<typeof ChainStepSchema>;

/** Schema for race configuration */
export const RaceConfigSchema = Type.Object({
  task: Type.String({ description: "Task to race across multiple models" }),
  models: Type.Array(Type.String(), {
    description: 'Models to compete (e.g., ["claude-haiku-4-5", "gpt-4o-mini"])',
  }),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Restrict tools" })),
  systemPrompt: Type.Optional(Type.String({ description: "Override system prompt" })),
});

export type RaceConfig = Static<typeof RaceConfigSchema>;

/** Main tool parameters schema */
export const ParallelParamsSchema = Type.Object({
  // Single task mode
  task: Type.Optional(Type.String({ description: "Single task to execute" })),
  model: Type.Optional(Type.String({ description: "Model for single task" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Tools for single task" })),
  systemPrompt: Type.Optional(Type.String({ description: "System prompt for single task" })),

  // Parallel mode
  tasks: Type.Optional(
    Type.Array(TaskItemSchema, {
      description: "Array of tasks to run in parallel",
    })
  ),
  context: Type.Optional(
    Type.String({
      description: "Shared context prepended to all parallel tasks",
    })
  ),
  maxConcurrency: Type.Optional(
    Type.Number({
      description: "Maximum concurrent tasks (default: 4)",
      default: 4,
    })
  ),

  // Chain mode
  chain: Type.Optional(
    Type.Array(ChainStepSchema, {
      description: "Sequential steps with {previous} placeholder",
    })
  ),

  // Race mode
  race: Type.Optional(RaceConfigSchema),

  // Common options
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
});

export type ParallelParams = Static<typeof ParallelParamsSchema>;

// ============================================================================
// Constants
// ============================================================================

export const MAX_CONCURRENCY = 8;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB
export const MAX_OUTPUT_LINES = 2000;
export const COLLAPSED_ITEM_COUNT = 10;
