/**
 * Shared workspace for team mode.
 *
 * Creates a temporary directory where team members can share artifacts.
 * Each team session gets its own workspace.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Workspace {
  /** Root directory of the workspace */
  root: string;
  /** Directory for task outputs / status */
  tasksDir: string;
  /** Directory for shared artifacts */
  artifactsDir: string;
}

/**
 * Create a new workspace for a team session.
 */
export function createWorkspace(teamName?: string): Workspace {
  const suffix = teamName
    ? teamName.replace(/[^\w-]/g, "_").slice(0, 30)
    : `team-${Date.now()}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-${suffix}-`));

  const tasksDir = path.join(root, "tasks");
  const artifactsDir = path.join(root, "artifacts");

  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  return { root, tasksDir, artifactsDir };
}

/**
 * Write a task result to the workspace.
 */
export function writeTaskResult(
  workspace: Workspace,
  taskId: string,
  output: string,
  status: "completed" | "failed"
): void {
  const safeName = taskId.replace(/[^\w.-]/g, "_");
  const filePath = path.join(workspace.tasksDir, `${safeName}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ id: taskId, status, output, timestamp: Date.now() }, null, 2),
    "utf-8"
  );
}

/**
 * Clean up a workspace directory.
 */
export function cleanupWorkspace(workspace: Workspace): void {
  try {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
