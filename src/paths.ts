import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Walk up from `startDir` to find the nearest `.git` directory.
 * Returns the directory containing `.git`, or `startDir` if none found.
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root with no .git found; fall back to startDir
      return startDir;
    }
    dir = parent;
  }
}

/**
 * Encode a project root path to a store directory name.
 * Rule: literal `-` is doubled to `--`, then `/` is replaced with `-`.
 * Example: /Users/foo/bar → -Users-foo-bar
 * Example: /Users/a-b/c → -Users-a--b-c
 */
export function encodePath(absPath: string): string {
  return absPath.replace(/-/g, "--").replace(/\//g, "-");
}

/**
 * Return the store directory for the given cwd.
 * Honors TASKS_HOME env var; falls back to ~/.tasks.
 */
export function storeDir(cwd: string): string {
  const tasksHome = process.env.TASKS_HOME ?? join(process.env.HOME ?? "~", ".tasks");
  const projectRoot = findProjectRoot(cwd);
  const encoded = encodePath(projectRoot);
  return join(tasksHome, "projects", encoded);
}

/**
 * Same as storeDir but does NOT create the directory.
 * Use for read-only commands that must not auto-initialize.
 */
export function resolveStoreDir(cwd: string): string {
  return storeDir(cwd);
}
