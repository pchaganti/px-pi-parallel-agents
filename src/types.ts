/**
 * Type definitions and Typebox schemas for the parallel agents tool.
 */

import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

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
  mode: "single" | "parallel" | "chain" | "race" | "team";
  results: TaskResult[];
  totalDurationMs: number;
  usage: UsageStats;
  progress?: TaskProgress[];
  winner?: string; // For race mode - the winning task id
  /** For team mode - DAG structure info */
  dagInfo?: {
    objective: string;
    members: Array<{ role: string; model?: string }>;
    tasks: Array<{
      id: string;
      assignee?: string;
      depends: string[];
      status: string;
      iteration?: number;
      maxIterations?: number;
    }>;
    pendingApproval?: {
      taskId: string;
      plan: string;
    };
  };
}

// ============================================================================
// Typebox Schemas
// ============================================================================

/** Agent scope for discovering agents */
export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

export type AgentScope = Static<typeof AgentScopeSchema>;

/** Schema for a single task item in parallel mode */
export const TaskItemSchema = Type.Object({
  task: Type.String({ description: "Task to execute" }),
  name: Type.Optional(Type.String({ description: "Display name for this task" })),
  agent: Type.Optional(
    Type.String({
      description: 'Name of an existing agent to use (from ~/.pi/agent/agents or .pi/agents). Agent settings (model, tools, systemPrompt) are used as defaults.',
    })
  ),
  provider: Type.Optional(
    Type.String({
      description: 'Provider name (e.g., "moonshot", "openai", "google"). Required when model name alone is ambiguous.',
    })
  ),
  model: Type.Optional(
    Type.String({
      description: 'Model to use (e.g., "claude-haiku-4-5", "gpt-4o-mini"). Overrides agent default.',
    })
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Restrict to specific tools (e.g., ["read", "grep", "find"]). Overrides agent default.',
    })
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Override system prompt for this task. Overrides agent default." })
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
  thinking: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: 'Thinking budget: number of tokens, or level like "low", "medium", "high". Overrides agent default.',
    })
  ),
});

export type TaskItem = Static<typeof TaskItemSchema>;

/** Schema for a chain step */
export const ChainStepSchema = Type.Object({
  task: Type.String({
    description: "Task with optional {previous} placeholder for prior output",
  }),
  agent: Type.Optional(
    Type.String({
      description: 'Name of an existing agent to use. Agent settings are used as defaults.',
    })
  ),
  provider: Type.Optional(
    Type.String({ description: 'Provider name (e.g., "moonshot", "openai").' })
  ),
  model: Type.Optional(Type.String({ description: "Model to use for this step. Overrides agent default." })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Restrict tools. Overrides agent default." })),
  systemPrompt: Type.Optional(Type.String({ description: "Override system prompt. Overrides agent default." })),
  thinking: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: 'Thinking budget: number of tokens, or level like "low", "medium", "high". Overrides agent default.',
    })
  ),
});

export type ChainStep = Static<typeof ChainStepSchema>;

/** Schema for race configuration */
export const RaceConfigSchema = Type.Object({
  task: Type.String({ description: "Task to race across multiple models" }),
  models: Type.Array(Type.String(), {
    description: 'Models to compete (e.g., ["claude-haiku-4-5", "gpt-4o-mini"])',
  }),
  provider: Type.Optional(
    Type.String({ description: 'Provider name for all race models (e.g., "moonshot").' })
  ),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Restrict tools" })),
  systemPrompt: Type.Optional(Type.String({ description: "Override system prompt" })),
  thinking: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: 'Thinking budget: number of tokens, or level like "low", "medium", "high"',
    })
  ),
});

export type RaceConfig = Static<typeof RaceConfigSchema>;

// ============================================================================
// Team Mode Schemas
// ============================================================================

/** Schema for a team member */
export const TeamMemberSchema = Type.Object({
  role: Type.String({ description: "Role name for this member (used as assignee in tasks)" }),
  agent: Type.Optional(
    Type.String({
      description: 'Name of an existing agent to use. Agent settings are used as defaults.',
    })
  ),
  provider: Type.Optional(
    Type.String({
      description: 'Provider name (e.g., "moonshot", "openai").',
    })
  ),
  model: Type.Optional(
    Type.String({
      description: 'Model to use (e.g., "claude-sonnet-4-5"). Overrides agent default.',
    })
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Restrict to specific tools. Overrides agent default.',
    })
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Override system prompt. Overrides agent default." })
  ),
  task: Type.Optional(
    Type.String({ description: "Default task description for this member (used if no tasks array is provided)" })
  ),
  thinking: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: 'Thinking budget. Overrides agent default.',
    })
  ),
});

export type TeamMemberDef = Static<typeof TeamMemberSchema>;

/** Schema for review/refinement configuration on a team task */
export const ReviewConfigSchema = Type.Object({
  assignee: Type.String({
    description: 'Role name of the reviewing member. Must be defined in the team members.',
  }),
  task: Type.Optional(
    Type.String({
      description: 'Review task prompt. Defaults to evaluating the task output. Use {output} for the worker output and {task} for the original task.',
    })
  ),
  maxIterations: Type.Optional(
    Type.Number({
      description: 'Maximum review cycles before auto-accepting (default: 3)',
      default: 3,
    })
  ),
  provider: Type.Optional(Type.String({ description: 'Provider for the reviewer.' })),
  model: Type.Optional(Type.String({ description: 'Model for the reviewer. Overrides member default.' })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Tools for the reviewer.' })),
});

export type ReviewConfig = Static<typeof ReviewConfigSchema>;

/** Schema for a team task with dependencies */
export const TeamTaskSchema = Type.Object({
  id: Type.String({ description: "Unique task identifier (used in depends and {task:id} references)" }),
  task: Type.String({ description: "Task description. Use {task:id} to reference output from a dependency." }),
  assignee: Type.Optional(Type.String({ description: "Role name of the member to run this task" })),
  depends: Type.Optional(
    Type.Array(Type.String(), {
      description: 'IDs of tasks that must complete before this one starts',
    })
  ),
  requiresApproval: Type.Optional(
    Type.Boolean({
      description: "If true, task runs in read-only mode and its output is returned for review before dependents proceed",
    })
  ),
  review: Type.Optional(ReviewConfigSchema),
});

export type TeamTask = Static<typeof TeamTaskSchema>;

/** Schema for team configuration */
export const TeamConfigSchema = Type.Object({
  objective: Type.String({ description: "Overall team objective / goal" }),
  members: Type.Array(TeamMemberSchema, {
    description: "Team members with roles and capabilities",
  }),
  tasks: Type.Optional(
    Type.Array(TeamTaskSchema, {
      description: "Tasks with dependencies forming a DAG. If omitted, each member runs their default task in parallel.",
    })
  ),
  maxConcurrency: Type.Optional(
    Type.Number({ description: "Max concurrent tasks (default: 4)", default: 4 })
  ),
});

export type TeamConfig = Static<typeof TeamConfigSchema>;

/** Main tool parameters schema */
export const ParallelParamsSchema = Type.Object({
  // Agent discovery
  agentScope: Type.Optional(AgentScopeSchema),

  // Single task mode
  task: Type.Optional(Type.String({ description: "Single task to execute" })),
  agent: Type.Optional(
    Type.String({
      description: 'Name of an existing agent to use (for single mode). Agent settings are used as defaults.',
    })
  ),
  provider: Type.Optional(Type.String({ description: 'Provider name (e.g., "moonshot", "openai", "google").' })),
  model: Type.Optional(Type.String({ description: "Model for single task. Overrides agent default." })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Tools for single task. Overrides agent default." })),
  systemPrompt: Type.Optional(Type.String({ description: "System prompt for single task. Overrides agent default." })),
  thinking: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: 'Thinking budget: number of tokens, or level like "low", "medium", "high". Overrides agent default.',
    })
  ),

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
  contextFiles: Type.Optional(
    Type.Array(Type.String(), {
      description: "File paths to read and include as context (auto-read before execution)",
    })
  ),
  gitContext: Type.Optional(
    Type.Union([
      Type.Boolean(),
      Type.Object({
        branch: Type.Optional(Type.Boolean({ description: "Include current branch name" })),
        diff: Type.Optional(Type.Boolean({ description: "Include git diff (staged + unstaged)" })),
        diffStats: Type.Optional(Type.Boolean({ description: "Include diff stats only (files changed)" })),
        log: Type.Optional(Type.Number({ description: "Include last N commit messages" })),
        status: Type.Optional(Type.Boolean({ description: "Include git status" })),
      }),
    ], {
      description: "Include git context. true = branch + diffStats + status. Or specify options.",
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

  // Team mode
  team: Type.Optional(TeamConfigSchema),

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
