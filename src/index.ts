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
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type ParallelParams,
  type ParallelToolDetails,
  type TaskProgress,
  type TaskResult,
  ParallelParamsSchema,
  createEmptyUsage,
  addUsage,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
} from "./types.js";
import { runAgent } from "./executor.js";
import { mapWithConcurrencyLimit, raceWithAbort } from "./parallel.js";
import { renderCall, renderResult } from "./render.js";

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
      "Model examples: claude-haiku-4-5, gpt-4o-mini, claude-sonnet-4-5",
    ].join("\n"),
    parameters: ParallelParamsSchema,

    async execute(_toolCallId, params: ParallelParams, signal, onUpdate, ctx) {
      const startTime = Date.now();
      const cwd = params.cwd || ctx.cwd;

      // Determine mode - check for non-empty values
      const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
      const hasRace = params.race !== undefined && params.race !== null;
      const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
      const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;

      const modeCount =
        Number(hasChain) + Number(hasRace) + Number(hasTasks) + Number(hasSingle);

      if (modeCount !== 1) {
        return {
          content: [
            {
              type: "text",
              text: "Invalid parameters. Provide exactly one mode: task (single), tasks (parallel), chain, or race.",
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

      // Helper to emit progress update
      const emitUpdate = (
        mode: ParallelToolDetails["mode"],
        results: TaskResult[],
        progress: TaskProgress[],
        winner?: string
      ) => {
        onUpdate?.({
          content: [{ type: "text", text: "Running..." }],
          details: makeDetails(mode, results, progress, winner),
        });
      };

      // ========================================================================
      // Single Mode
      // ========================================================================
      if (hasSingle && params.task) {
        const progress: TaskProgress[] = [];

        const result = await runAgent({
          task: params.task,
          cwd,
          model: params.model,
          tools: params.tools,
          systemPrompt: params.systemPrompt,
          id: "single",
          name: "single",
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

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const stepId = generateTaskId(i + 1, `step_${i + 1}`);

          // Initialize progress for this step
          progress[i] = {
            id: stepId,
            name: `Step ${i + 1}`,
            status: "running",
            task: taskWithContext,
            model: step.model,
            recentTools: [],
            recentOutput: [],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
          };

          const result = await runAgent({
            task: taskWithContext,
            cwd,
            model: step.model,
            tools: step.tools,
            systemPrompt: step.systemPrompt,
            id: stepId,
            name: `Step ${i + 1}`,
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
        const { task, models, tools, systemPrompt } = params.race;
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
              model,
              tools,
              systemPrompt,
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

        const progress: TaskProgress[] = tasks.map((t, i) => ({
          id: generateTaskId(i, t.name),
          name: t.name,
          status: "pending" as const,
          task: t.task,
          model: t.model,
          recentTools: [],
          recentOutput: [],
          toolCount: 0,
          tokens: 0,
          durationMs: 0,
        }));

        const allResults: TaskResult[] = [];

        const { results: parallelResults, aborted } = await mapWithConcurrencyLimit(
          tasks,
          maxConcurrency,
          async (t, index) => {
            const taskId = generateTaskId(index, t.name);

            progress[index].status = "running";
            emitUpdate("parallel", allResults, progress);

            const result = await runAgent({
              task: t.task,
              cwd: t.cwd || cwd,
              model: t.model,
              tools: t.tools,
              systemPrompt: t.systemPrompt,
              context: params.context,
              id: taskId,
              name: t.name,
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
        const summaries = results.map((r) => {
          const output = r.output;
          const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
          return `[${r.name || r.id}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded${aborted ? " (aborted)" : ""}\n\n${summaries.join("\n\n")}`,
            },
          ],
          details: makeDetails("parallel", results, progress),
        };
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
