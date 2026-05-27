import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const COLUMNS = ["backlog", "ready", "doing", "blocked", "review", "done"];

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
      // Reached filesystem root with no .git found — fall back to startDir
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
function encodePath(absPath: string): string {
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
 * Run a git command in the given directory. Returns exit code.
 */
async function git(args: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exited;
}

/**
 * Ensure the store at `dir` exists and is initialized.
 * If it doesn't exist yet, creates it, runs `git init`, creates an empty
 * initial commit, creates the six column directories, and prints an init
 * notice to stderr.
 *
 * Returns true if the store was freshly initialized, false if it already existed.
 */
export async function ensureStore(dir: string): Promise<boolean> {
  if (existsSync(join(dir, ".git"))) {
    return false;
  }

  // Create the store directory and column subdirectories
  mkdirSync(dir, { recursive: true });
  for (const col of COLUMNS) {
    mkdirSync(join(dir, col), { recursive: true });
  }

  // git init
  await git(["init"], dir);

  // Empty initial commit
  await git(["commit", "--allow-empty", "-m", "init"], dir);

  process.stderr.write(`tasks: initialized store at ${dir}\n`);
  return true;
}
