/**
 * DAG (Directed Acyclic Graph) engine for team task execution.
 *
 * Tasks form a dependency graph. Independent tasks run in parallel,
 * dependent tasks wait for their prerequisites to complete.
 * Tasks with `requiresApproval` pause the DAG and return the plan
 * for review before continuing.
 */

import type { TeamTask, TaskResult, TaskProgress, ReviewConfig } from "./types.js";
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
  status: "pending" | "blocked" | "ready" | "running" | "completed" | "failed" | "awaiting_approval" | "reviewing" | "revising";
  /** Result once completed */
  result?: TaskResult;
  /** Current iteration (1-based), set when task has review config */
  iteration?: number;
  /** History of review feedback for iterative refinement */
  reviewHistory?: Array<{
    iteration: number;
    workerOutput: string;
    reviewerOutput: string;
    approved: boolean;
  }>;
  /** All results from iterations (worker + reviewer runs) */
  iterationResults?: TaskResult[];
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
    // Validate review assignee
    if (node.task.review?.assignee && !members.has(node.task.review.assignee)) {
      throw new Error(`Task "${id}" review assigned to unknown member "${node.task.review.assignee}"`);
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
 * Check if there's a task awaiting review or revision.
 */
export function getReviewableTasks(nodes: Map<string, DagNode>): DagNode[] {
  return [...nodes.values()].filter(
    (n) => n.status === "reviewing"
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

/** Default max review iterations */
const DEFAULT_MAX_ITERATIONS = 3;

/** The system prompt addition for reviewers */
const REVIEWER_INSTRUCTIONS = `

## Review Protocol

You are reviewing work output from a team member. Evaluate the output carefully.

**You MUST end your response with one of these two markers on its own line:**

- \`APPROVED\` — if the work meets the requirements and is ready to use
- \`REVISION_NEEDED\` — if the work needs changes, followed by your specific feedback

Example approved response:
\`\`\`
The implementation looks correct and complete. Good error handling and clear code structure.

APPROVED
\`\`\`

Example revision response:
\`\`\`
The implementation has issues:
1. Missing error handling for edge case X
2. The function Y should validate inputs

REVISION_NEEDED
\`\`\`
`;

/**
 * Parse a reviewer's output to determine if the work was approved.
 * Returns { approved, feedback }.
 */
export function parseReviewDecision(output: string): { approved: boolean; feedback: string } {
  const trimmed = output.trim();
  const lines = trimmed.split("\n");

  // Check last non-empty lines for markers
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line === "APPROVED") {
      // Everything before the marker is the feedback/rationale
      const feedback = lines.slice(0, i).join("\n").trim();
      return { approved: true, feedback };
    }
    if (line === "REVISION_NEEDED") {
      const feedback = lines.slice(0, i).join("\n").trim();
      return { approved: false, feedback };
    }
    // Only check the last non-empty line
    break;
  }

  // If no explicit marker found, check for the words in the last portion
  const lastChunk = trimmed.slice(-200).toLowerCase();
  if (lastChunk.includes("approved") && !lastChunk.includes("not approved") && !lastChunk.includes("revision")) {
    return { approved: true, feedback: trimmed };
  }

  // Default: treat as needing revision with the full output as feedback
  return { approved: false, feedback: trimmed };
}

/**
 * Build the review task prompt.
 */
function buildReviewPrompt(
  reviewConfig: ReviewConfig,
  originalTask: string,
  workerOutput: string,
  iteration: number,
  maxIterations: number,
  previousFeedback?: string
): string {
  const basePrompt = reviewConfig.task
    ? reviewConfig.task
        .replace(/\{output\}/g, workerOutput)
        .replace(/\{task\}/g, originalTask)
    : `Review the following work output and determine if it meets the requirements of the original task.\n\n## Original Task\n\n${originalTask}\n\n## Work Output\n\n${workerOutput}`;

  let prompt = basePrompt;
  prompt += `\n\n---\nThis is review iteration ${iteration}/${maxIterations}.`;

  if (previousFeedback) {
    prompt += `\n\n## Previous Review Feedback\n\n${previousFeedback}`;
  }

  if (iteration >= maxIterations) {
    prompt += `\n\n**This is the final iteration.** Please either approve the work or provide final feedback. The work will be accepted after this review regardless.`;
  }

  return prompt;
}

/**
 * Build the revision task prompt for a worker re-doing their task.
 */
function buildRevisionPrompt(
  originalTask: string,
  reviewFeedback: string,
  iteration: number,
  maxIterations: number,
  previousOutput: string
): string {
  return `${originalTask}

---

## Revision Required (Attempt ${iteration}/${maxIterations})

Your previous output was reviewed and needs changes. Here is your previous output and the reviewer's feedback:

### Your Previous Output

${previousOutput}

### Reviewer Feedback

${reviewFeedback}

Please revise your work to address the reviewer's feedback. Focus on the specific issues mentioned.`;
}

/**
 * Resolve \`{task:id}\` references in task text with completed task outputs.
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
        else if (node.status === "reviewing") p.status = "running";
        else if (node.status === "revising") p.status = "running";
      }
    }
    onProgress?.(nodes, [...progressMap.values()]);
  };

  emitProgress();

  // Helper: build shared context for a task
  function buildTaskContext(node: DagNode): string | undefined {
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

    return contextParts.length > 0 ? contextParts.join("\n\n---\n\n") : undefined;
  }

  // Helper: run the review cycle for a node that just produced output
  async function runReviewCycle(node: DagNode): Promise<void> {
    const review = node.task.review!;
    const maxIter = review.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const reviewMember = members.get(review.assignee);
    const taskId = node.task.id;

    if (!node.iteration) node.iteration = 1;
    if (!node.reviewHistory) node.reviewHistory = [];
    if (!node.iterationResults) node.iterationResults = [];

    while (node.iteration <= maxIter) {
      if (signal?.aborted) return;

      const workerOutput = node.result?.output ?? "";
      const previousFeedback = node.reviewHistory.length > 0
        ? node.reviewHistory[node.reviewHistory.length - 1].reviewerOutput
        : undefined;

      // --- Run reviewer ---
      node.status = "reviewing";
      const reviewProgressId = `${taskId}:review:${node.iteration}`;
      progressMap.set(reviewProgressId, {
        id: reviewProgressId,
        name: `${review.assignee}:review(${taskId}#${node.iteration})`,
        status: "running",
        task: `Reviewing ${taskId} (iteration ${node.iteration})`,
        model: review.model ?? reviewMember?.model,
        recentTools: [],
        recentOutput: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
      });
      emitProgress();

      const reviewPrompt = buildReviewPrompt(
        review,
        node.task.task,
        workerOutput,
        node.iteration,
        maxIter,
        previousFeedback
      );

      // Build reviewer system prompt with review protocol
      const reviewerSystemPrompt = (reviewMember?.systemPrompt ?? "") + REVIEWER_INSTRUCTIONS;

      const reviewResult = await runAgent({
        task: reviewPrompt,
        cwd,
        provider: review.provider ?? reviewMember?.provider,
        model: review.model ?? reviewMember?.model,
        tools: review.tools ?? reviewMember?.tools,
        systemPrompt: reviewerSystemPrompt,
        thinking: reviewMember?.thinking,
        context: buildTaskContext(node),
        id: reviewProgressId,
        name: `${review.assignee}:review(${taskId})`,
        signal,
        onProgress: (p) => {
          progressMap.set(reviewProgressId, p);
          emitProgress();
        },
      });

      node.iterationResults!.push(reviewResult);
      allResults.push(reviewResult);

      // Update review progress
      const rp = progressMap.get(reviewProgressId);
      if (rp) rp.status = reviewResult.exitCode === 0 ? "completed" : "failed";

      if (reviewResult.exitCode !== 0 || reviewResult.aborted) {
        // Review failed — accept the worker's current output
        node.status = "completed";
        const p = progressMap.get(taskId);
        if (p) p.status = "completed";
        emitProgress();
        return;
      }

      // Parse review decision
      const decision = parseReviewDecision(reviewResult.output);

      node.reviewHistory!.push({
        iteration: node.iteration,
        workerOutput,
        reviewerOutput: reviewResult.output,
        approved: decision.approved,
      });

      if (decision.approved || node.iteration >= maxIter) {
        // Approved or max iterations reached — task is done
        node.status = "completed";
        const p = progressMap.get(taskId);
        if (p) p.status = "completed";
        emitProgress();
        return;
      }

      // --- Revision needed: re-run worker ---
      node.iteration++;
      node.status = "revising";
      const revisionProgressId = `${taskId}:revision:${node.iteration}`;

      // Update the main task progress to show it's being revised
      const mainProgress = progressMap.get(taskId);
      if (mainProgress) {
        mainProgress.status = "running";
        mainProgress.name = `${node.assignee?.role ?? taskId}:${taskId}#${node.iteration}`;
      }
      progressMap.set(revisionProgressId, {
        id: revisionProgressId,
        name: `${node.assignee?.role ?? taskId}:${taskId}#${node.iteration}`,
        status: "running",
        task: `Revising ${taskId} (iteration ${node.iteration})`,
        model: node.assignee?.model,
        recentTools: [],
        recentOutput: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
      });
      emitProgress();

      const revisionPrompt = buildRevisionPrompt(
        resolveTaskReferences(node.task.task, nodes),
        decision.feedback,
        node.iteration,
        maxIter,
        workerOutput
      );

      const revisionResult = await runAgent({
        task: revisionPrompt,
        cwd,
        provider: node.assignee?.provider,
        model: node.assignee?.model,
        tools: node.assignee?.tools,
        systemPrompt: node.assignee?.systemPrompt,
        thinking: node.assignee?.thinking,
        context: buildTaskContext(node),
        id: revisionProgressId,
        name: node.assignee?.role ? `${node.assignee.role}:${taskId}` : taskId,
        signal,
        onProgress: (p) => {
          progressMap.set(revisionProgressId, p);
          emitProgress();
        },
      });

      node.iterationResults!.push(revisionResult);
      allResults.push(revisionResult);

      // Update revision progress
      const revP = progressMap.get(revisionProgressId);
      if (revP) revP.status = revisionResult.exitCode === 0 ? "completed" : "failed";

      if (revisionResult.exitCode !== 0 || revisionResult.aborted) {
        // Revision failed — mark task as failed
        node.status = "failed";
        node.result = revisionResult;
        const p = progressMap.get(taskId);
        if (p) p.status = "failed";
        emitProgress();
        return;
      }

      // Update the node's result with the new output
      node.result = revisionResult;
      // Continue loop → will review again
    }
  }

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

      const context = buildTaskContext(node);

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
      } else if (node.task.review) {
        // Task has a review config — enter review cycle
        // Initialize iteration tracking
        node.iteration = 1;
        node.reviewHistory = [];
        node.iterationResults = [result];
        // Don't mark as completed yet — run the review loop
        await runReviewCycle(node);
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
