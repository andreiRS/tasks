import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, closeSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

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
 * Same as storeDir but does NOT create the directory.
 * Use for read-only commands that must not auto-initialize.
 */
export function resolveStoreDir(cwd: string): string {
  return storeDir(cwd);
}

/**
 * Convert a title to a URL/filename slug.
 * Lowercase, replace runs of non-alphanumeric chars with `-`, trim dashes.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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

  // Ignore the lock file — flock(1) needs a real file on disk, but we don't
  // want it tracked or showing up in `git status`.
  writeFileSync(join(dir, ".gitignore"), ".tasks-lock\n", "utf-8");
  await git(["add", ".gitignore"], dir);

  // Initial commit (includes .gitignore)
  await git(["commit", "-m", "init"], dir);

  process.stderr.write(`tasks: initialized store at ${dir}\n`);
  return true;
}

/**
 * Locate the system `flock(1)` binary. Searches PATH via `Bun.which`, then a
 * couple of well-known locations. Returns null if not found.
 *
 * Note: hardened "flock missing → actionable error" is a future cycle; callers
 * may throw a generic error if this returns null.
 */
function findFlock(): string | null {
  const found = Bun.which("flock");
  if (found) return found;
  for (const candidate of ["/opt/homebrew/bin/flock", "/usr/bin/flock", "/usr/local/bin/flock"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Acquire an exclusive flock on `<storeDir>/.tasks-lock`, run `fn`, then release.
 *
 * Implementation: spawn `flock -x <lockfile> cat` with stdin piped. flock(1)
 * only execs `cat` AFTER acquiring the lock, so we synchronize by writing a
 * byte to stdin and reading it back from stdout — once we see the echo, `cat`
 * is running which means the lock is held. When `fn` completes we close stdin,
 * `cat` exits, and flock releases the lock.
 */
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(dir, ".tasks-lock");
  // Ensure the lock file exists (flock needs an fd to flock on)
  if (!existsSync(lockPath)) {
    closeSync(openSync(lockPath, "w"));
  }

  const flockBin = findFlock();
  if (!flockBin) {
    throw new Error("flock not found on PATH");
  }

  const lockProc = Bun.spawn([flockBin, "-x", lockPath, "cat"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Synchronize: write a byte and read it echoed back from `cat` — confirms
  // `cat` is running, which means flock has acquired the lock.
  const sink = lockProc.stdin as unknown as {
    write: (chunk: string | Uint8Array) => number;
    flush: () => Promise<number> | number;
    end: () => void;
  };
  sink.write("x");
  await sink.flush();

  const reader = lockProc.stdout.getReader();
  await reader.read();
  reader.releaseLock();

  try {
    return await fn();
  } finally {
    sink.end();
    await lockProc.exited;
  }
}

/**
 * Create a new task in the store.
 * Allocates an ID from meta.yaml, writes the task file to backlog/,
 * updates meta.yaml, and commits both files atomically.
 *
 * Returns the short id of the new task.
 */
export async function createTask(dir: string, title: string): Promise<number> {
  return withLock(dir, async () => {
    // Read or initialize meta.yaml
    const metaPath = join(dir, "meta.yaml");
    let nextId = 1;
    if (existsSync(metaPath)) {
      const raw = readFileSync(metaPath, "utf-8");
      const match = raw.match(/next_id:\s*(\d+)/);
      if (match) {
        nextId = parseInt(match[1], 10);
      }
    }

    const id = nextId;
    const uuid = randomUUID();
    const now = new Date().toISOString();
    const slug = slugify(title);
    const filename = `${id}-${slug}.md`;
    const taskPath = join(dir, "backlog", filename);

    const frontmatter = yamlStringify({
      id,
      uuid,
      title,
      created_at: now,
      updated_at: now,
    });

    const fileContent = `---\n${frontmatter}---\n`;
    writeFileSync(taskPath, fileContent, "utf-8");

    // Update meta.yaml
    writeFileSync(metaPath, `next_id: ${id + 1}\n`, "utf-8");

    // Stage both files and commit
    const taskRelPath = `backlog/${filename}`;
    await git(["add", taskRelPath, "meta.yaml"], dir);
    await git(["commit", "-m", `task: new #${id} — ${title}`], dir);

    return id;
  });
}

// ─── Task data type (structured output) ──────────────────────────────────────

export interface TaskData {
  id: number;
  uuid: string;
  title: string;
  column: string;
  created_at: string;
  updated_at: string;
  body: string;
  deps: string[];
  agent_ready: boolean;
  human_in_loop: boolean;
}

/**
 * Parse a task file's raw content into frontmatter + body.
 * Body is everything after the closing `---` line, with exactly one leading
 * newline stripped (so a freshly created task with `---\n` at the end yields "").
 */
function parseTaskFile(content: string): { fm: Record<string, unknown>; body: string } {
  // Split on the second `---` delimiter
  const parts = content.split(/^---\s*$/m);
  // parts[0] is empty (before the first ---), parts[1] is frontmatter, parts[2+] is body
  if (parts.length < 3) {
    return { fm: {}, body: "" };
  }
  const fm = yamlParse(parts[1]) as Record<string, unknown>;
  // Join remaining parts (in case body itself contained ---)
  const rawBody = parts.slice(2).join("---");
  // Strip exactly one leading newline
  const body = rawBody.startsWith("\n") ? rawBody.slice(1) : rawBody;
  return { fm, body };
}

/**
 * Find a task by short id (positive integer string) or UUID.
 * Walks all six column directories.
 * Returns TaskData (with normalized defaults) or null if not found.
 *
 * Does NOT auto-initialize the store.
 */
export function findTask(dir: string, idOrUuid: string): TaskData | null {
  if (!existsSync(dir)) {
    return null;
  }

  const byShortId = /^\d+$/.test(idOrUuid);
  const targetId = byShortId ? parseInt(idOrUuid, 10) : null;

  for (const col of COLUMNS) {
    const colDir = join(dir, col);
    if (!existsSync(colDir)) continue;

    let files: string[];
    try {
      files = readdirSync(colDir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }

    for (const filename of files) {
      const filePath = join(colDir, filename);
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const { fm, body } = parseTaskFile(raw);

      const matches = byShortId
        ? fm.id === targetId
        : fm.uuid === idOrUuid;

      if (matches) {
        return {
          id: fm.id as number,
          uuid: fm.uuid as string,
          title: fm.title as string,
          column: col,
          created_at: fm.created_at as string,
          updated_at: fm.updated_at as string,
          body,
          deps: Array.isArray(fm.deps) ? (fm.deps as string[]) : [],
          agent_ready: typeof fm.agent_ready === "boolean" ? fm.agent_ready : false,
          human_in_loop: typeof fm.human_in_loop === "boolean" ? fm.human_in_loop : false,
        };
      }
    }
  }

  return null;
}
