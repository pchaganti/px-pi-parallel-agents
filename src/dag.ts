/**
 * DAG (Directed Acyclic Graph) engine for team task execution.
 *
 * Tasks form a dependency graph. Independent tasks run in parallel,
 * dependent tasks wait for their prerequisites to complete.
 * Tasks with `requiresApproval` pause the DAG and return the plan
 * for review before continuing.
 */

import type { TeamTask, TaskResult, TaskProgress } from "./types.js";
import { runAgent } from "./executor.js";
import type { AgentConfig } from "./agents.js";

// ============================================================================
// Types
// ============================================================================

export interface DagNode {
  task: TeamTask;
  /** Resolved agent/model settings for this task's assignee */
  assignee?: TeamMember;
  /** IDs of tasks this depends on */
  dependsOn: string[];
  /** IDs of tasks that depend on this */
  dependedBy: string[];
  /** Current status */
  status: "pending" | "blocked" | "ready" | "running" | "completed" | "failed" | "awaiting_approval";
  /** Result once completed */
  result?: TaskResult;
}

export interface TeamMember {
  role: string;
  agent?: string;
  agentConfig?: AgentConfig;
  provider?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  thinking?: number | string;
}

export interface DagExecutionOptions {
  nodes: Map<string, DagNode>;
  members: Map<string, TeamMember>;
  objective: string;
  cwd: string;
  maxConcurrency: number;
  sharedContext?: string;
  workspacePath?: string;
  signal?: AbortSignal;
  onProgress?: (nodes: Map<string, DagNode>, progress: TaskProgress[]) => void;
  /** Called when a task requires approval. Return true to approve, false to reject with feedback. */
  onApprovalNeeded?: (taskId: string, plan: string) => Promise<{ approved: boolean; feedback?: string }>;
}

export interface DagExecutionResult {
  results: TaskResult[];
  /** If we paused for approval, which task is waiting */
  pendingApproval?: {
    taskId: string;
    plan: string;
  };
  aborted: boolean;
}

// ============================================================================
// DAG Construction
// ============================================================================

/**
 * Build a DAG from team tasks, validating the graph.
 * Throws if there are cycles or missing dependencies.
 */
export function buildDag(
  tasks: TeamTask[],
  members: Map<string, TeamMember>
): Map<string, DagNode> {
  const nodes = new Map<string, DagNode>();

  // Check for duplicate IDs
  const seenIds = new Set<string>();
  for (const task of tasks) {
    if (seenIds.has(task.id)) {
      throw new Error(`Duplicate task ID: "${task.id}"`);
    }
    seenIds.add(task.id);
  }

  // Create nodes
  for (const task of tasks) {
    const member = task.assignee ? members.get(task.assignee) : undefined;
    nodes.set(task.id, {
      task,
      assignee: member,
      dependsOn: task.depends ?? [],
      dependedBy: [],
      status: "pending",
    });
  }

  // Validate dependencies and build reverse edges
  for (const [id, node] of nodes) {
    for (const depId of node.dependsOn) {
      const depNode = nodes.get(depId);
      if (!depNode) {
        throw new Error(`Task "${id}" depends on unknown task "${depId}"`);
      }
      depNode.dependedBy.push(id);
    }
  }

  // Validate assignees
  for (const [id, node] of nodes) {
    if (node.task.assignee && !members.has(node.task.assignee)) {
      throw new Error(`Task "${id}" assigned to unknown member "${node.task.assignee}"`);
    }
  }

  // Detect cycles with topological sort
  detectCycles(nodes);

  // Mark initial ready state
  updateReadyState(nodes);

  return nodes;
}

/**
 * Detect cycles using Kahn's algorithm.
 * Throws if cycles are found.
 */
function detectCycles(nodes: Map<string, DagNode>): void {
  const inDegree = new Map<string, number>();
  for (const [id, node] of nodes) {
    inDegree.set(id, node.dependsOn.length);
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    const node = nodes.get(id)!;
    for (const depId of node.dependedBy) {
      const newDegree = (inDegree.get(depId) ?? 0) - 1;
      inDegree.set(depId, newDegree);
      if (newDegree === 0) queue.push(depId);
    }
  }

  if (visited < nodes.size) {
    // Find tasks involved in cycle for better error message
    const inCycle = [...inDegree.entries()]
      .filter(([_, d]) => d > 0)
      .map(([id]) => id);
    throw new Error(`Dependency cycle detected involving tasks: ${inCycle.join(", ")}`);
  }
}

/**
 * Update which tasks are ready to run.
 * A task is ready if all its dependencies are completed.
 */
function updateReadyState(nodes: Map<string, DagNode>): void {
  for (const [_, node] of nodes) {
    if (node.status !== "pending") continue;

    const allDepsComplete = node.dependsOn.every((depId) => {
      const dep = nodes.get(depId);
      return dep?.status === "completed";
    });

    const anyDepFailed = node.dependsOn.some((depId) => {
      const dep = nodes.get(depId);
      return dep?.status === "failed";
    });

    if (anyDepFailed) {
      node.status = "blocked";
    } else if (allDepsComplete) {
      node.status = "ready";
    }
  }
}

/**
 * Get tasks that are ready to run.
 */
export function getReadyTasks(nodes: Map<string, DagNode>): DagNode[] {
  return [...nodes.values()].filter((n) => n.status === "ready");
}

/**
 * Check if the DAG is complete (all tasks completed or blocked).
 */
export function isDagComplete(nodes: Map<string, DagNode>): boolean {
  return [...nodes.values()].every(
    (n) => n.status === "completed" || n.status === "failed" || n.status === "blocked"
  );
}

/**
 * Check if there's a task awaiting approval.
 */
export function getPendingApproval(nodes: Map<string, DagNode>): DagNode | undefined {
  return [...nodes.values()].find((n) => n.status === "awaiting_approval");
}

// ============================================================================
// Task Text Resolution
// ============================================================================

/**
 * Resolve `{task:id}` references in task text with completed task outputs.
 */
export function resolveTaskReferences(
  text: string,
  nodes: Map<string, DagNode>
): string {
  return text.replace(/\{task:([^}]+)\}/g, (match, taskId) => {
    const node = nodes.get(taskId);
    if (node?.result?.output) {
      return node.result.output;
    }
    return match; // Keep placeholder if not resolved
  });
}

// ============================================================================
// DAG Execution
// ============================================================================

/**
 * Execute the DAG, running independent tasks in parallel.
 *
 * The executor repeatedly:
 * 1. Finds ready tasks (all deps completed)
 * 2. Runs them in parallel (up to maxConcurrency)
 * 3. Updates task status and readiness
 * 4. Repeats until all tasks are done
 *
 * If a task has `requiresApproval`, the DAG pauses and returns
 * a partial result with the plan for review.
 */
export async function executeDag(
  options: DagExecutionOptions
): Promise<DagExecutionResult> {
  const {
    nodes,
    members,
    objective,
    cwd,
    maxConcurrency,
    sharedContext,
    workspacePath,
    signal,
    onProgress,
    onApprovalNeeded,
  } = options;

  const allResults: TaskResult[] = [];
  const progressMap = new Map<string, TaskProgress>();

  // Initialize progress for all tasks
  for (const [id, node] of nodes) {
    progressMap.set(id, {
      id,
      name: node.task.assignee ? `${node.task.assignee}:${id}` : id,
      status: node.status === "ready" ? "pending" : "pending",
      task: node.task.task,
      model: node.assignee?.model,
      recentTools: [],
      recentOutput: [],
      toolCount: 0,
      tokens: 0,
      durationMs: 0,
    });
  }

  const emitProgress = () => {
    // Sync progress statuses with node statuses
    for (const [id, node] of nodes) {
      const p = progressMap.get(id);
      if (p) {
        if (node.status === "blocked") p.status = "aborted";
        else if (node.status === "ready") p.status = "pending";
        else if (node.status === "awaiting_approval") p.status = "running";
      }
    }
    onProgress?.(nodes, [...progressMap.values()]);
  };

  emitProgress();

  // Main execution loop
  while (!isDagComplete(nodes)) {
    if (signal?.aborted) {
      return { results: allResults, aborted: true };
    }

    // Check for pending approval
    const approvalNode = getPendingApproval(nodes);
    if (approvalNode) {
      // If we don't have an approval handler, auto-approve
      if (!onApprovalNeeded) {
        approvalNode.status = "completed";
        updateReadyState(nodes);
        emitProgress();
        continue;
      }

      const plan = approvalNode.result?.output ?? "";
      const decision = await onApprovalNeeded(approvalNode.task.id, plan);

      if (decision.approved) {
        approvalNode.status = "completed";
        updateReadyState(nodes);
        emitProgress();
        continue;
      } else {
        // Re-run the task with feedback
        approvalNode.status = "ready";
        if (decision.feedback) {
          approvalNode.task.task += `\n\n[FEEDBACK - your previous plan was rejected]: ${decision.feedback}\n\nPlease revise your plan based on this feedback.`;
        }
        // Fall through to pick it up in the ready tasks below
      }
    }

    const readyTasks = getReadyTasks(nodes);

    if (readyTasks.length === 0) {
      // No tasks ready and not complete - all remaining are blocked
      break;
    }

    // Run ready tasks with concurrency limit
    const batch = readyTasks.slice(0, maxConcurrency);

    // Mark as running
    for (const node of batch) {
      node.status = "running";
      const p = progressMap.get(node.task.id);
      if (p) p.status = "running";
    }
    emitProgress();

    // Execute batch in parallel
    const batchPromises = batch.map(async (node) => {
      const taskId = node.task.id;
      const member = node.assignee;

      // Resolve task text with references to completed tasks
      const resolvedTask = resolveTaskReferences(node.task.task, nodes);

      // Build context
      const contextParts: string[] = [];
      if (objective) {
        contextParts.push(`## Team Objective\n\n${objective}`);
      }
      if (sharedContext) {
        contextParts.push(sharedContext);
      }
      if (workspacePath) {
        contextParts.push(`## Shared Workspace\n\nThe team workspace directory is: ${workspacePath}\nYou can read artifacts from other team members there, and write your own artifacts for others to use.`);
      }

      // Add dependency outputs as context
      for (const depId of node.dependsOn) {
        const depNode = nodes.get(depId);
        if (depNode?.result?.output) {
          const depName = depNode.task.assignee
            ? `${depNode.task.assignee} (${depId})`
            : depId;
          contextParts.push(
            `## Output from prerequisite task "${depName}"\n\n${depNode.result.output}`
          );
        }
      }

      const context = contextParts.length > 0 ? contextParts.join("\n\n---\n\n") : undefined;

      // Determine tools - restrict to read-only if requires approval
      let tools = member?.tools;
      if (node.task.requiresApproval && node.status === "running") {
        // First run: restrict to read-only tools for planning
        tools = ["read", "bash", "grep", "find", "mcp"];
      }

      const result = await runAgent({
        task: resolvedTask,
        cwd,
        provider: member?.provider,
        model: member?.model,
        tools,
        systemPrompt: member?.systemPrompt,
        thinking: member?.thinking,
        context,
        id: taskId,
        name: member?.role ? `${member.role}:${taskId}` : taskId,
        signal,
        onProgress: (p) => {
          progressMap.set(taskId, p);
          emitProgress();
        },
      });

      return { taskId, result };
    });

    const batchResults = await Promise.all(batchPromises);

    // Process results
    for (const { taskId, result } of batchResults) {
      const node = nodes.get(taskId)!;
      node.result = result;
      allResults.push(result);

      if (result.exitCode !== 0 || result.aborted) {
        node.status = "failed";
        const p = progressMap.get(taskId);
        if (p) p.status = "failed";
      } else if (node.task.requiresApproval) {
        // Task completed but needs approval before dependents can proceed
        node.status = "awaiting_approval";
      } else {
        node.status = "completed";
        const p = progressMap.get(taskId);
        if (p) p.status = "completed";
      }
    }

    // Update readiness after this batch
    updateReadyState(nodes);
    emitProgress();
  }

  return {
    results: allResults,
    aborted: signal?.aborted ?? false,
  };
}

/**
 * Get a topological ordering of task IDs (for display).
 */
export function getTopologicalOrder(nodes: Map<string, DagNode>): string[] {
  const order: string[] = [];
  const inDegree = new Map<string, number>();

  for (const [id, node] of nodes) {
    inDegree.set(id, node.dependsOn.length);
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    const node = nodes.get(id)!;
    for (const depId of node.dependedBy) {
      const newDegree = (inDegree.get(depId) ?? 0) - 1;
      inDegree.set(depId, newDegree);
      if (newDegree === 0) queue.push(depId);
    }
  }

  return order;
}
