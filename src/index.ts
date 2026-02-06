/**
 * Pi Parallel Agents Extension
 *
 * A dynamic parallel execution system that allows multiple agents to run in parallel
 * with different models, without requiring pre-defined agent configurations.
 *
 * Supports four execution modes:
 * - Single: One task with optional model/tools override
 * - Parallel: Multiple tasks running concurrently
 * - Chain: Sequential execution with {previous} placeholder
 * - Race: Multiple models compete on the same task
 * 
 * Agents can be specified inline (model, tools, systemPrompt) or by referencing
 * existing agent definitions from ~/.pi/agent/agents or .pi/agents.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type ParallelParams,
  type ParallelToolDetails,
  type TaskProgress,
  type TaskResult,
  type AgentScope,
  type TeamTask,
  ParallelParamsSchema,
  createEmptyUsage,
  addUsage,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
} from "./types.js";
import { runAgent } from "./executor.js";
import { mapWithConcurrencyLimit, raceWithAbort } from "./parallel.js";
import { renderCall, renderResult } from "./render.js";
import { discoverAgents, findAgent, formatAgentList, type AgentConfig } from "./agents.js";
import { buildContext } from "./context.js";
import { buildDag, executeDag, type TeamMember, type DagNode } from "./dag.js";
import { createWorkspace, writeTaskResult, cleanupWorkspace } from "./workspace.js";

/**
 * Generate a unique task ID.
 */
function generateTaskId(index: number, name?: string): string {
  const suffix = name ? name.replace(/[^\w-]/g, "_").slice(0, 20) : `task_${index}`;
  return `${index}-${suffix}`;
}

/**
 * Aggregate usage stats from multiple results.
 */
function aggregateUsage(results: TaskResult[]): ReturnType<typeof createEmptyUsage> {
  const total = createEmptyUsage();
  for (const r of results) {
    addUsage(total, r.usage);
  }
  return total;
}

/**
 * Resolve agent settings, merging agent defaults with inline overrides.
 * Inline parameters take precedence over agent defaults.
 */
function resolveAgentSettings(
  agentName: string | undefined,
  agents: AgentConfig[],
  overrides: {
    provider?: string;
    model?: string;
    tools?: string[];
    systemPrompt?: string;
    thinking?: number | string;
  }
): {
  provider?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  thinking?: number | string;
  agentConfig?: AgentConfig;
} {
  if (!agentName) {
    return { ...overrides };
  }

  const agentConfig = findAgent(agents, agentName);
  if (!agentConfig) {
    // Agent not found - just use overrides
    return { ...overrides };
  }

  // Merge: inline overrides take precedence
  return {
    provider: overrides.provider,
    model: overrides.model ?? agentConfig.model,
    tools: overrides.tools ?? agentConfig.tools,
    systemPrompt: overrides.systemPrompt ?? agentConfig.systemPrompt,
    thinking: overrides.thinking ?? agentConfig.thinking,
    agentConfig,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "parallel",
    label: "Parallel Agents",
    description: [
      "Run agents in parallel with different models.",
      "Modes:",
      "- Single: { task, model?, tools? }",
      "- Parallel: { tasks: [{task, model?, name?}, ...], maxConcurrency? }",
      "- Chain: { chain: [{task, model?}, ...] } - sequential with {previous} placeholder",
      "- Race: { race: {task, models: [...]} } - first to complete wins",
      "- Team: { team: {objective, members: [{role, model?}], tasks: [{id, task, assignee?, depends?, review?}]} } - DAG-based team coordination with optional iterative refinement",
      "Model examples: claude-haiku-4-5, gpt-4o-mini, claude-sonnet-4-5",
      "Use `provider` to specify the provider (e.g., moonshot, openai, google) when the model name alone is ambiguous.",
      "",
      "Agents: Reference existing agents by name (from ~/.pi/agent/agents or .pi/agents).",
      "Set agentScope to 'both' to include project-local agents.",
      "Agent settings (model, tools, systemPrompt) are used as defaults; inline params override.",
      "",
      "Context options (parallel mode):",
      "- gitContext: true (or {branch, diff, status, log}) - auto-include git info",
      "- contextFiles: ['path/to/file.rs'] - auto-read and include file contents",
      "- context: 'string' - manual context string",
      "",
      "Team mode: Coordinate a team of agents with task dependencies and iterative review loops.",
      "- members define roles with model/tools/systemPrompt",
      "- tasks form a DAG with `depends` arrays and `{task:id}` references",
      "- Independent tasks run in parallel; dependent tasks wait",
      "- `requiresApproval: true` pauses for plan review before dependents proceed",
      "- If no tasks array, each member runs their default task in parallel",
      "",
      "IMPORTANT: Each agent runs in the same working directory with full tool access (read, bash, etc).",
      "Do NOT pre-fetch data or write temp files for agents - they can use git, grep, find, etc. directly.",
      "Just describe what they should do; they'll gather the information themselves.",
    ].join("\n"),
    parameters: ParallelParamsSchema,

    async execute(_toolCallId, params: ParallelParams, signal, onUpdate, ctx) {
      const startTime = Date.now();
      const cwd = params.cwd || ctx.cwd;
      
      // Discover available agents
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(cwd, agentScope);
      const agents = discovery.agents;

      // Determine mode - check for non-empty values
      const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
      const hasRace = params.race !== undefined && params.race !== null;
      const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
      const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
      const hasTeam = params.team !== undefined && params.team !== null;

      const modeCount =
        Number(hasChain) + Number(hasRace) + Number(hasTasks) + Number(hasSingle) + Number(hasTeam);

      if (modeCount !== 1) {
        const { text: agentList } = formatAgentList(agents, 5);
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode: task (single), tasks (parallel), chain, race, or team.\n\nAvailable agents [${agentScope}]: ${agentList}`,
            },
          ],
          details: {
            mode: "single",
            results: [],
            totalDurationMs: 0,
            usage: createEmptyUsage(),
          } as ParallelToolDetails,
        };
      }

      // Helper to create details
      const makeDetails = (
        mode: ParallelToolDetails["mode"],
        results: TaskResult[],
        progress?: TaskProgress[],
        winner?: string
      ): ParallelToolDetails => ({
        mode,
        results,
        totalDurationMs: Date.now() - startTime,
        usage: aggregateUsage(results),
        progress,
        winner,
      });

      // Helper to emit progress update with partial outputs
      const emitUpdate = (
        mode: ParallelToolDetails["mode"],
        results: TaskResult[],
        progress: TaskProgress[],
        winner?: string
      ) => {
        // Build a summary of current progress including partial outputs
        const running = progress.filter(p => p.status === "running");
        const completed = progress.filter(p => p.status === "completed");
        
        let statusText = `Running: ${running.length} in progress, ${completed.length}/${progress.length} complete`;
        
        // Include recent output from running tasks (streaming partial results)
        for (const p of running) {
          if (p.recentOutput.length > 0) {
            const lastOutput = p.recentOutput[p.recentOutput.length - 1];
            statusText += `\n\n**${p.name || p.id}** (${p.toolCount} tools): ${lastOutput}`;
          } else if (p.currentTool) {
            statusText += `\n\n**${p.name || p.id}**: running ${p.currentTool}...`;
          }
        }
        
        onUpdate?.({
          content: [{ type: "text", text: statusText }],
          details: makeDetails(mode, results, progress, winner),
        });
      };

      // ========================================================================
      // Single Mode
      // ========================================================================
      if (hasSingle && params.task) {
        const progress: TaskProgress[] = [];
        
        // Resolve agent settings
        const resolved = resolveAgentSettings(params.agent, agents, {
          provider: params.provider,
          model: params.model,
          tools: params.tools,
          systemPrompt: params.systemPrompt,
          thinking: params.thinking,
        });
        
        // Warn if agent was specified but not found
        if (params.agent && !resolved.agentConfig) {
          const { text: agentList } = formatAgentList(agents, 5);
          return {
            content: [
              {
                type: "text",
                text: `Unknown agent: ${params.agent}\n\nAvailable agents [${agentScope}]: ${agentList}`,
              },
            ],
            details: makeDetails("single", []),
          };
        }

        const result = await runAgent({
          task: params.task,
          cwd,
          provider: resolved.provider,
          model: resolved.model,
          tools: resolved.tools,
          systemPrompt: resolved.systemPrompt,
          thinking: resolved.thinking,
          id: "single",
          name: resolved.agentConfig?.name || "single",
          signal,
          onProgress: (p) => {
            progress[0] = p;
            emitUpdate("single", [], progress);
          },
        });

        return {
          content: [{ type: "text", text: result.output || "(no output)" }],
          details: makeDetails("single", [result]),
        };
      }

      // ========================================================================
      // Chain Mode
      // ========================================================================
      if (hasChain && params.chain) {
        const results: TaskResult[] = [];
        const progress: TaskProgress[] = [];
        let previousOutput = "";
        
        // Validate all agents exist before starting
        const missingAgents: string[] = [];
        for (const step of params.chain) {
          if (step.agent && !findAgent(agents, step.agent)) {
            missingAgents.push(step.agent);
          }
        }
        if (missingAgents.length > 0) {
          const { text: agentList } = formatAgentList(agents, 5);
          return {
            content: [
              {
                type: "text",
                text: `Unknown agent(s) in chain: ${missingAgents.join(", ")}\n\nAvailable agents [${agentScope}]: ${agentList}`,
              },
            ],
            details: makeDetails("chain", []),
          };
        }

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const stepId = generateTaskId(i + 1, `step_${i + 1}`);
          
          // Resolve agent settings for this step
          const resolved = resolveAgentSettings(step.agent, agents, {
            provider: step.provider,
            model: step.model,
            tools: step.tools,
            systemPrompt: step.systemPrompt,
            thinking: step.thinking,
          });
          const stepName = resolved.agentConfig?.name || `Step ${i + 1}`;

          // Initialize progress for this step
          progress[i] = {
            id: stepId,
            name: stepName,
            status: "running",
            task: taskWithContext,
            model: resolved.model,
            recentTools: [],
            recentOutput: [],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
          };

          const result = await runAgent({
            task: taskWithContext,
            cwd,
            provider: resolved.provider,
            model: resolved.model,
            tools: resolved.tools,
            systemPrompt: resolved.systemPrompt,
            thinking: resolved.thinking,
            id: stepId,
            name: stepName,
            step: i + 1,
            signal,
            onProgress: (p) => {
              progress[i] = p;
              emitUpdate("chain", results, progress);
            },
          });

          results.push(result);

          // Check for failure
          if (result.exitCode !== 0 || result.aborted) {
            const errorMsg = result.error || result.output || "(no output)";
            return {
              content: [
                {
                  type: "text",
                  text: `Chain stopped at step ${i + 1}: ${errorMsg}`,
                },
              ],
              details: makeDetails("chain", results),
              isError: true,
            };
          }

          previousOutput = result.output;
        }

        const lastResult = results[results.length - 1];
        return {
          content: [
            { type: "text", text: lastResult?.output || "(no output)" },
          ],
          details: makeDetails("chain", results),
        };
      }

      // ========================================================================
      // Race Mode
      // ========================================================================
      if (hasRace && params.race) {
        const { task, models, provider: raceProvider, tools, systemPrompt, thinking } = params.race;
        const results: TaskResult[] = [];
        const progress: TaskProgress[] = [];

        // Initialize progress for all racers
        for (let i = 0; i < models.length; i++) {
          const model = models[i];
          progress[i] = {
            id: model,
            name: model,
            status: "pending",
            task,
            model,
            recentTools: [],
            recentOutput: [],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
          };
        }

        const raceTasks = models.map((model, index) => ({
          id: model,
          run: async (raceSignal: AbortSignal): Promise<TaskResult> => {
            progress[index].status = "running";
            emitUpdate("race", results, progress);

            const result = await runAgent({
              task,
              cwd,
              provider: raceProvider,
              model,
              tools,
              systemPrompt,
              thinking,
              id: model,
              name: model,
              signal: raceSignal,
              onProgress: (p) => {
                progress[index] = p;
                emitUpdate("race", results, progress);
              },
            });

            progress[index].status = result.exitCode === 0 ? "completed" : "failed";
            results.push(result);
            emitUpdate("race", results, progress);

            if (result.exitCode !== 0) {
              throw new Error(result.error || "Task failed");
            }

            return result;
          },
        }));

        const raceResult = await raceWithAbort(raceTasks, signal);

        if ("aborted" in raceResult) {
          return {
            content: [{ type: "text", text: "Race aborted" }],
            details: makeDetails("race", results, progress),
            isError: true,
          };
        }

        return {
          content: [
            { type: "text", text: raceResult.result.output || "(no output)" },
          ],
          details: makeDetails("race", results, progress, raceResult.winner),
        };
      }

      // ========================================================================
      // Parallel Mode
      // ========================================================================
      if (hasTasks && params.tasks) {
        const tasks = params.tasks;
        const maxConcurrency = Math.min(
          params.maxConcurrency || DEFAULT_CONCURRENCY,
          MAX_CONCURRENCY,
          tasks.length
        );
        
        // Build shared context from all sources
        // Default to basic git info (branch + status) if nothing specified
        const sharedContext = buildContext(cwd, {
          context: params.context,
          contextFiles: params.contextFiles,
          gitContext: params.gitContext ?? { branch: true, status: true },
        });
        
        // Validate all agents exist before starting
        const missingAgents: string[] = [];
        for (const t of tasks) {
          if (t.agent && !findAgent(agents, t.agent)) {
            missingAgents.push(t.agent);
          }
        }
        if (missingAgents.length > 0) {
          const { text: agentList } = formatAgentList(agents, 5);
          return {
            content: [
              {
                type: "text",
                text: `Unknown agent(s): ${[...new Set(missingAgents)].join(", ")}\n\nAvailable agents [${agentScope}]: ${agentList}`,
              },
            ],
            details: makeDetails("parallel", []),
          };
        }

        const progress: TaskProgress[] = tasks.map((t, i) => {
          const resolved = resolveAgentSettings(t.agent, agents, { provider: t.provider, model: t.model });
          return {
            id: generateTaskId(i, t.name || resolved.agentConfig?.name),
            name: t.name || resolved.agentConfig?.name,
            status: "pending" as const,
            task: t.task,
            model: resolved.model,
            recentTools: [],
            recentOutput: [],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
          };
        });

        const allResults: TaskResult[] = [];
        
        // Check if any task has cross-references to other tasks
        const crossRefPattern = /\{(task|result)_(\d+)\}/;
        const hasCrossRefs = tasks.some(t => crossRefPattern.test(t.task));

        const { results: parallelResults, aborted } = await mapWithConcurrencyLimit(
          tasks,
          // If cross-refs exist, run sequentially to allow substitution
          hasCrossRefs ? 1 : maxConcurrency,
          async (t, index) => {
            // Resolve agent settings for this task
            const resolved = resolveAgentSettings(t.agent, agents, {
              provider: t.provider,
              model: t.model,
              tools: t.tools,
              systemPrompt: t.systemPrompt,
              thinking: t.thinking,
            });
            
            const taskId = generateTaskId(index, t.name || resolved.agentConfig?.name);
            const taskName = t.name || resolved.agentConfig?.name;

            progress[index].status = "running";
            emitUpdate("parallel", allResults, progress);
            
            // Substitute cross-references with previous task outputs
            let taskText = t.task;
            if (hasCrossRefs) {
              taskText = taskText.replace(/\{(task|result)_(\d+)\}/g, (match, _type, numStr) => {
                const refIndex = parseInt(numStr, 10);
                if (refIndex >= 0 && refIndex < allResults.length) {
                  return allResults[refIndex].output || "(no output from task)";
                }
                return match; // Keep placeholder if referenced task doesn't exist yet
              });
            }

            const result = await runAgent({
              task: taskText,
              cwd: t.cwd || cwd,
              provider: resolved.provider,
              model: resolved.model,
              tools: resolved.tools,
              systemPrompt: resolved.systemPrompt,
              thinking: resolved.thinking,
              context: sharedContext,
              id: taskId,
              name: taskName,
              signal,
              onProgress: (p) => {
                progress[index] = p;
                emitUpdate("parallel", allResults, progress);
              },
            });

            progress[index].status =
              result.exitCode === 0 ? "completed" : "failed";
            allResults.push(result);
            emitUpdate("parallel", allResults, progress);

            return result;
          },
          signal
        );

        // Collect results (filter undefined from aborted tasks)
        const results = parallelResults.filter((r): r is TaskResult => r !== undefined);

        const successCount = results.filter((r) => r.exitCode === 0).length;
        
        // Build detailed summaries - save full output to files when truncated
        const summaries = results.map((r, idx) => {
          const output = r.output.trim();
          const stats: string[] = [];
          if (r.usage.turns > 0) stats.push(`${r.usage.turns} turns`);
          if (r.model) stats.push(r.model);
          if (r.usage.cost > 0) stats.push(`$${r.usage.cost.toFixed(4)}`);
          const statsStr = stats.length > 0 ? ` (${stats.join(", ")})` : "";
          const status = r.exitCode === 0 ? "✓" : "✗";
          
          // Build tool usage summary from progress
          const taskProgress = progress[idx];
          let toolSummary = "";
          if (taskProgress && taskProgress.recentTools.length > 0) {
            const toolCounts = new Map<string, number>();
            for (const t of taskProgress.recentTools) {
              toolCounts.set(t.tool, (toolCounts.get(t.tool) || 0) + 1);
            }
            const toolList = Array.from(toolCounts.entries())
              .map(([tool, count]) => count > 1 ? `${tool}×${count}` : tool)
              .join(", ");
            const moreTools = taskProgress.toolCount - taskProgress.recentTools.length;
            toolSummary = moreTools > 0 
              ? `\n**Tools used:** ${toolList} (+${moreTools} more)`
              : `\n**Tools used:** ${toolList}`;
          } else if (taskProgress && taskProgress.toolCount > 0) {
            toolSummary = `\n**Tools used:** ${taskProgress.toolCount} tool calls`;
          }
          
          // Include output - up to 2000 chars per task, save full to file if longer
          const maxLen = 2000;
          let outputSection: string;
          
          if (output.length > maxLen) {
            // Save full output to temp file
            const safeName = (r.name || r.id || `task_${idx}`).replace(/[^\w.-]/g, "_");
            const outputPath = path.join(os.tmpdir(), `parallel-${safeName}-${Date.now()}.md`);
            try {
              fs.writeFileSync(outputPath, output, "utf-8");
              r.fullOutputPath = outputPath;
              outputSection = output.slice(0, maxLen) + `\n\n... [truncated, full output: ${outputPath}]`;
            } catch {
              // If write fails, just show truncated
              outputSection = output.slice(0, maxLen) + `\n... [${output.length - maxLen} more chars]`;
            }
          } else {
            outputSection = output || "(no output)";
          }
          
          return `### ${status} ${r.name || r.id}${statsStr}${toolSummary}\n\n${outputSection}`;
        });

        // Calculate total cost
        const totalCost = results.reduce((sum, r) => sum + (r.usage.cost || 0), 0);
        const costInfo = totalCost > 0 ? ` | Total cost: $${totalCost.toFixed(4)}` : "";

        return {
          content: [
            {
              type: "text",
              text: `## Parallel: ${successCount}/${results.length} succeeded${aborted ? " (aborted)" : ""}${costInfo}\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel", results, progress),
        };
      }

      // ========================================================================
      // Team Mode
      // ========================================================================
      if (hasTeam && params.team) {
        const { objective, members: memberDefs, tasks: taskDefs, maxConcurrency: teamMaxConcurrency } = params.team;
        const maxConc = Math.min(
          teamMaxConcurrency || DEFAULT_CONCURRENCY,
          MAX_CONCURRENCY
        );

        // Build shared context
        const sharedContext = buildContext(cwd, {
          context: params.context,
          contextFiles: params.contextFiles,
          gitContext: params.gitContext ?? { branch: true, status: true },
        });

        // Create workspace
        const workspace = createWorkspace();

        try {
          // Build members map, resolving agent settings
          const membersMap = new Map<string, TeamMember>();
          const missingAgents: string[] = [];

          for (const memberDef of memberDefs) {
            const resolved = resolveAgentSettings(memberDef.agent, agents, {
              provider: memberDef.provider,
              model: memberDef.model,
              tools: memberDef.tools,
              systemPrompt: memberDef.systemPrompt,
              thinking: memberDef.thinking,
            });

            if (memberDef.agent && !resolved.agentConfig) {
              missingAgents.push(memberDef.agent);
            }

            membersMap.set(memberDef.role, {
              role: memberDef.role,
              agent: memberDef.agent,
              agentConfig: resolved.agentConfig,
              provider: resolved.provider,
              model: resolved.model,
              tools: resolved.tools,
              systemPrompt: resolved.systemPrompt,
              thinking: resolved.thinking,
            });
          }

          if (missingAgents.length > 0) {
            const { text: agentList } = formatAgentList(agents, 5);
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown agent(s) in team: ${[...new Set(missingAgents)].join(", ")}\n\nAvailable agents [${agentScope}]: ${agentList}`,
                },
              ],
              details: makeDetails("team", []),
            };
          }

          // Build tasks
          let teamTasks: TeamTask[];

          if (taskDefs && taskDefs.length > 0) {
            // Explicit task DAG
            teamTasks = taskDefs;
          } else {
            // Auto-generate: each member runs their default task in parallel
            teamTasks = memberDefs
              .filter((m) => m.task)
              .map((m) => ({
                id: m.role,
                task: m.task!,
                assignee: m.role,
              }));

            if (teamTasks.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Team mode requires either a `tasks` array or each member must have a `task` field.",
                  },
                ],
                details: makeDetails("team", []),
              };
            }
          }

          // Build and validate DAG
          let dagNodes: Map<string, DagNode>;
          try {
            dagNodes = buildDag(teamTasks, membersMap);
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Team DAG error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              details: makeDetails("team", []),
              isError: true,
            };
          }

          // Execute the DAG
          const dagResult = await executeDag({
            nodes: dagNodes,
            members: membersMap,
            objective,
            cwd,
            maxConcurrency: maxConc,
            sharedContext: sharedContext || undefined,
            workspacePath: workspace.root,
            signal,
            onProgress: (nodes, progress) => {
              emitUpdate("team", [], progress);
            },
          });

          // Write results to workspace for persistence
          for (const result of dagResult.results) {
            writeTaskResult(
              workspace,
              result.id,
              result.output,
              result.exitCode === 0 ? "completed" : "failed"
            );
          }

          const results = dagResult.results;
          const primaryTaskCount = teamTasks.length;
          const successCount = teamTasks.filter((t) => {
            const node = dagNodes.get(t.id);
            return node?.status === "completed";
          }).length;

          // Build DAG info for details
          const dagInfo: ParallelToolDetails["dagInfo"] = {
            objective,
            members: memberDefs.map((m) => ({
              role: m.role,
              model: membersMap.get(m.role)?.model,
            })),
            tasks: teamTasks.map((t) => {
              const node = dagNodes.get(t.id);
              return {
                id: t.id,
                assignee: t.assignee,
                depends: t.depends ?? [],
                status: node?.status ?? "pending",
                iteration: node?.iteration,
                maxIterations: t.review?.maxIterations,
              };
            }),
          };

          // Build summaries — only for primary task results (skip review/revision sub-results)
          const primaryResults = results.filter((r) => {
            // Primary results are those whose ID matches a task ID directly
            return teamTasks.some((t) => t.id === r.id);
          });

          // Also include review/revision results for reporting
          const reviewResults = results.filter((r) => {
            return r.id.includes(":review:") || r.id.includes(":revision:");
          });

          const summaries = primaryResults.map((r, idx) => {
            const output = r.output.trim();
            const stats: string[] = [];
            if (r.usage.turns > 0) stats.push(`${r.usage.turns} turns`);
            if (r.model) stats.push(r.model);
            if (r.usage.cost > 0) stats.push(`$${r.usage.cost.toFixed(4)}`);
            const statsStr = stats.length > 0 ? ` (${stats.join(", ")})` : "";
            const status = r.exitCode === 0 ? "✓" : "✗";

            // Find assignee info
            const taskDef = teamTasks.find((t) => t.id === r.id);
            const assigneeInfo = taskDef?.assignee ? `[${taskDef.assignee}] ` : "";

            // Check if this task went through review iterations
            const dagNode = dagNodes.get(r.id);
            let iterationInfo = "";
            if (dagNode?.iteration && dagNode.iteration > 1) {
              iterationInfo = ` 🔄 ${dagNode.iteration} iterations`;
            }
            if (dagNode?.reviewHistory && dagNode.reviewHistory.length > 0) {
              const lastReview = dagNode.reviewHistory[dagNode.reviewHistory.length - 1];
              iterationInfo += lastReview.approved ? " ✅ approved" : " ⚠️ max iterations reached";
            }

            // Include output - up to 2000 chars per task
            const maxLen = 2000;
            let outputSection: string;

            if (output.length > maxLen) {
              const safeName = (r.name || r.id || `task_${idx}`).replace(/[^\w.-]/g, "_");
              const outputPath = path.join(os.tmpdir(), `team-${safeName}-${Date.now()}.md`);
              try {
                fs.writeFileSync(outputPath, output, "utf-8");
                r.fullOutputPath = outputPath;
                outputSection = output.slice(0, maxLen) + `\n\n... [truncated, full output: ${outputPath}]`;
              } catch {
                outputSection = output.slice(0, maxLen) + `\n... [${output.length - maxLen} more chars]`;
              }
            } else {
              outputSection = output || "(no output)";
            }

            // Add review history summary if available
            let reviewSection = "";
            if (dagNode?.reviewHistory && dagNode.reviewHistory.length > 0) {
              reviewSection = "\n\n#### Review History\n";
              for (const rh of dagNode.reviewHistory) {
                const icon = rh.approved ? "✅" : "❌";
                const feedbackPreview = rh.reviewerOutput.length > 300
                  ? rh.reviewerOutput.slice(0, 300) + "..."
                  : rh.reviewerOutput;
                reviewSection += `\n**Iteration ${rh.iteration}** ${icon}\n${feedbackPreview}\n`;
              }
            }

            return `### ${status} ${assigneeInfo}${r.name || r.id}${iterationInfo}${statsStr}\n\n${outputSection}${reviewSection}`;
          });

          // Calculate total cost
          const totalCost = results.reduce((sum, r) => sum + (r.usage.cost || 0), 0);
          const costInfo = totalCost > 0 ? ` | Total cost: $${totalCost.toFixed(4)}` : "";

          // Report blocked tasks
          const blockedTasks = [...dagNodes.values()].filter((n) => n.status === "blocked");
          const blockedInfo = blockedTasks.length > 0
            ? `\n\n**Blocked tasks:** ${blockedTasks.map((n) => n.task.id).join(", ")} (dependencies failed)`
            : "";

          return {
            content: [
              {
                type: "text",
                text: `## Team: ${successCount}/${primaryTaskCount} tasks succeeded${dagResult.aborted ? " (aborted)" : ""}${costInfo}\n\n**Objective:** ${objective}${blockedInfo}\n\n${summaries.join("\n\n---\n\n")}`,
              },
            ],
            details: {
              ...makeDetails("team", results),
              dagInfo,
            },
          };
        } finally {
          // Cleanup workspace
          cleanupWorkspace(workspace);
        }
      }

      // Should not reach here
      return {
        content: [{ type: "text", text: "Invalid parameters" }],
        details: makeDetails("single", []),
      };
    },

    renderCall,
    renderResult,
  });
}
