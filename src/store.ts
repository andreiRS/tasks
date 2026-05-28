import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, closeSync, openSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

/**
 * A structured error thrown by the tasks CLI store layer.
 * `code` is a stable machine-readable enum value (e.g. "FLOCK_MISSING").
 * `details` carries any extra context the caller wants to surface.
 */
export class TasksError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "TasksError";
  }
}

export const COLUMNS = ["backlog", "ready", "doing", "blocked", "review", "done"];

/**
 * Sibling directory holding archived tasks. NOT a Column: transitions never
 * target it, list/board/next skip it by default, and the only way in is the
 * dedicated `tasks archive` command. See `docs/adr/0010-archive-as-sibling-directory.md`.
 */
export const ARCHIVE_DIR = "archive";

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
    await upsertGitignore(dir);
    return false;
  }

  // Create the store directory and column subdirectories
  mkdirSync(dir, { recursive: true });
  for (const col of COLUMNS) {
    mkdirSync(join(dir, col), { recursive: true });
  }
  mkdirSync(join(dir, ARCHIVE_DIR), { recursive: true });

  // git init
  await git(["init"], dir);

  writeFileSync(join(dir, ".gitignore"), STORE_GITIGNORE, "utf-8");
  await git(["add", ".gitignore"], dir);

  // Initial commit (includes .gitignore)
  await git(["commit", "-m", "init"], dir);

  process.stderr.write(`tasks: initialized store at ${dir}\n`);
  return true;
}

/**
 * Explicitly initialize the store at `dir`.
 *
 * Functionally identical to `ensureStore` but ALSO creates `meta.yaml` with
 * `next_id: 1` and includes it in the initial seed commit, so the store is
 * fully usable after `tasks init` without waiting for the first `tasks new`.
 *
 * Idempotent: when the store already exists (`.git` present) this returns
 * immediately with `created: false` and does NOT re-init, re-commit, or
 * overwrite anything.
 *
 * Returns `{ created: boolean; path: string }`.
 */
export async function initStore(dir: string): Promise<{ created: boolean; path: string }> {
  if (existsSync(join(dir, ".git"))) {
    return { created: false, path: dir };
  }

  // Create the store directory and column subdirectories
  mkdirSync(dir, { recursive: true });
  for (const col of COLUMNS) {
    mkdirSync(join(dir, col), { recursive: true });
  }
  mkdirSync(join(dir, ARCHIVE_DIR), { recursive: true });

  // git init
  await git(["init"], dir);

  // Write .gitignore and meta.yaml, stage both, then initial commit
  writeFileSync(join(dir, ".gitignore"), STORE_GITIGNORE, "utf-8");
  writeFileSync(join(dir, "meta.yaml"), "next_id: 1\n", "utf-8");
  await git(["add", ".gitignore", "meta.yaml"], dir);
  await git(["commit", "-m", "init"], dir);

  process.stderr.write(`tasks: initialized store at ${dir}\n`);
  return { created: true, path: dir };
}

/**
 * Canonical store `.gitignore`. The lock file is required (flock(1) needs a
 * real on-disk file but it must not be tracked). The remaining patterns
 * cover editor droppings that would otherwise leave the store dirty after
 * an `edit` and trip the STORE_DIRTY guard on the next mutating command.
 */
const STORE_GITIGNORE = [
  ".tasks-lock",
  "",
  "# Editor droppings",
  ".*.sw?",     // vim swap (.foo.swp, .foo.swo, …)
  "*~",         // emacs/nano backup
  ".#*",        // emacs lockfile
  "*.bak",
  "*.orig",
  "",
  "# OS junk",
  ".DS_Store",
  "Thumbs.db",
  "",
].join("\n");

/**
 * Idempotently ensure the store's `.gitignore` matches the canonical
 * content. If the file is missing or differs, write it and commit just
 * that path so a pre-existing dirty tree elsewhere is not touched.
 */
async function upsertGitignore(dir: string): Promise<void> {
  const path = join(dir, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (current === STORE_GITIGNORE) return;
  writeFileSync(path, STORE_GITIGNORE, "utf-8");
  await git(["add", ".gitignore"], dir);
  await git(["commit", "-m", "store: refresh .gitignore", "--", ".gitignore"], dir);
}

/**
 * Return the path to flock(1) by searching only via PATH (Bun.which), or
 * throw a TasksError with code FLOCK_MISSING if it cannot be found.
 *
 * Call this as the FIRST check in any mutating command so the failure is
 * actionable before any git or filesystem work is attempted.
 *
 * NOTE: Unlike findFlock (which also checks hardcoded locations), this
 * function intentionally respects PATH only; hardcoded fallbacks would
 * silently succeed even when a user hasn't set up their PATH correctly.
 */
export function findFlockOrFail(): string {
  const flockBin = Bun.which("flock");
  if (!flockBin) {
    throw new TasksError(
      "FLOCK_MISSING",
      "tasks: 'flock' not found on PATH. Install it with: brew install flock",
      { hint: "brew install flock" }
    );
  }
  return flockBin;
}

/**
 * Acquire an exclusive flock on `<storeDir>/.tasks-lock`, run `fn`, then release.
 *
 * Implementation: spawn `flock -x <lockfile> cat` with stdin piped. flock(1)
 * only execs `cat` AFTER acquiring the lock, so we synchronize by writing a
 * byte to stdin and reading it back from stdout; once we see the echo, `cat`
 * is running which means the lock is held. When `fn` completes we close stdin,
 * `cat` exits, and flock releases the lock.
 */
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(dir, ".tasks-lock");
  // Ensure the lock file exists (flock needs an fd to flock on)
  if (!existsSync(lockPath)) {
    closeSync(openSync(lockPath, "w"));
  }

  const flockBin = findFlockOrFail();

  const lockProc = Bun.spawn([flockBin, "-x", lockPath, "cat"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Synchronize: write a byte and read it echoed back from `cat`; confirms
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
 * Return true if the store's working tree has any uncommitted changes
 * (staged or unstaged), false if the tree is clean.
 *
 * Runs `git status --porcelain` in the store directory. A non-empty
 * output means the tree is dirty.
 *
 * Call this AFTER acquiring the flock (i.e. inside withLock) so
 * concurrent invocations serialize the check.
 */
export async function isStoreDirty(dir: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "-C", dir, "status", "--porcelain"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const out = await new Response(proc.stdout).text();
  return out.trim().length > 0;
}

export interface CreateTaskOptions {
  attendance?: "attended" | "unattended";
  effort?: "low" | "medium" | "high";
  /** UUIDs of tasks this task depends on (already resolved and validated by caller). */
  deps?: string[];
  /** Body text to write after the frontmatter. */
  body?: string;
  /**
   * Optional editor runner. When provided, the editor is opened on the task
   * file after creation and the file is re-validated/recommitted if changed.
   * Returns the on-disk outcome for the caller.
   */
  runEditor?: EditorRunner;
}

/**
 * Create a new task in the store.
 * Allocates an ID from meta.yaml, writes the task file to backlog/,
 * updates meta.yaml, and commits both files atomically.
 *
 * Returns the short id of the new task.
 */
export async function createTask(dir: string, title: string, opts: CreateTaskOptions = {}): Promise<number> {
  return withLock(dir, async () => {
    // Reject if any existing task file carries an invalid enum value.
    validateEnums(dir);

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

    const attendance = opts.attendance ?? DEFAULT_ATTENDANCE;
    const effort = opts.effort ?? DEFAULT_EFFORT;
    const deps = opts.deps ?? [];
    const body = opts.body ?? "";

    const frontmatter = yamlStringify({
      id,
      uuid,
      title,
      deps,
      attendance,
      effort,
      created_at: now,
      updated_at: now,
    });

    const fileContent = `---\n${frontmatter}---\n${body}`;
    writeFileSync(taskPath, fileContent, "utf-8");

    // Update meta.yaml
    writeFileSync(metaPath, `next_id: ${id + 1}\n`, "utf-8");

    const taskRelPath = `backlog/${filename}`;

    // If an editor runner was provided, open the editor on the newly created
    // file BEFORE committing. This keeps the invariant of one commit per
    // invocation: the single commit covers the file's final state after the
    // editor session, including any user edits. On editor failure or
    // validation failure we roll back the on-disk writes so the working tree
    // stays clean and no abandoned id is wasted in meta.yaml.
    if (opts.runEditor) {
      const rollback = (): void => {
        try { rmSync(taskPath, { force: true }); } catch { /* ignore */ }
        try {
          if (existsSync(metaPath)) {
            // Restore the previous next_id so the abandoned id is reused.
            writeFileSync(metaPath, `next_id: ${id}\n`, "utf-8");
          }
        } catch { /* ignore */ }
      };

      const before = readFileSync(taskPath, "utf-8");

      let exit: number;
      try {
        exit = await opts.runEditor(taskPath);
      } catch (err) {
        rollback();
        throw new TasksError(
          "EDITOR_FAILED",
          `editor failed: ${err instanceof Error ? err.message : String(err)}`,
          {},
        );
      }
      if (exit !== 0) {
        rollback();
        throw new TasksError("EDITOR_FAILED", `editor exited with code ${exit}`, { exit });
      }

      const after = readFileSync(taskPath, "utf-8");
      if (after !== before) {
        // Parse and validate. Bad title -> roll back, throw.
        const parts = after.split(/^---\s*$/m);
        if (parts.length < 3) {
          rollback();
          throw new TasksError("INVALID_TITLE", "task file is missing YAML frontmatter", {});
        }
        let fm: Record<string, unknown>;
        try {
          fm = yamlParse(parts[1]) as Record<string, unknown>;
        } catch (err) {
          rollback();
          throw new TasksError(
            "INVALID_TITLE",
            `invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
            {},
          );
        }
        const titleErr = validateTitle(fm.title);
        if (titleErr !== null) {
          rollback();
          throw new TasksError("INVALID_TITLE", titleErr, {});
        }

        // Bump updated_at so timestamps reflect the editor session.
        const editNow = new Date().toISOString();
        const bumped = after.replace(/^(updated_at:\s*)(.+)$/m, `$1${editNow}`);
        writeFileSync(taskPath, bumped, "utf-8");
      }
    }

    // Stage both files and commit. Exactly one commit per invocation, whether
    // or not the editor ran (and whether or not the editor mutated the file).
    await git(["add", taskRelPath, "meta.yaml"], dir);
    await git(["commit", "-m", `task: new #${id}: ${title}`], dir);

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
  attendance: "attended" | "unattended";
  effort: "low" | "medium" | "high";
}

/**
 * Allowed enum values for the M8 frontmatter fields.
 */
export const ATTENDANCE_VALUES = ["attended", "unattended"] as const;
export const EFFORT_VALUES = ["low", "medium", "high"] as const;
export const DEFAULT_ATTENDANCE: "attended" = "attended";
export const DEFAULT_EFFORT: "medium" = "medium";

/**
 * Resolve a raw frontmatter `attendance` value to a valid enum member or null
 * if the value is present-but-invalid. A missing value resolves to the default.
 */
function resolveAttendance(value: unknown): "attended" | "unattended" | null {
  if (value === undefined || value === null) return DEFAULT_ATTENDANCE;
  if (typeof value !== "string") return null;
  if ((ATTENDANCE_VALUES as readonly string[]).includes(value)) {
    return value as "attended" | "unattended";
  }
  return null;
}

function resolveEffort(value: unknown): "low" | "medium" | "high" | null {
  if (value === undefined || value === null) return DEFAULT_EFFORT;
  if (typeof value !== "string") return null;
  if ((EFFORT_VALUES as readonly string[]).includes(value)) {
    return value as "low" | "medium" | "high";
  }
  return null;
}

/**
 * Validate the attendance/effort enum values across every task file in the
 * store. Throws TasksError with code INVALID_ATTENDANCE or INVALID_EFFORT on
 * the first offending file. Missing fields are accepted (treated as defaults).
 *
 * Call from any mutating command (after the dirty-tree guard, before the
 * mutation proper) so an out-of-band corruption is surfaced before any new
 * commit lands.
 */
export function validateEnums(dir: string): void {
  if (!existsSync(dir)) return;
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
      const parts = raw.split(/^---\s*$/m);
      if (parts.length < 3) continue;
      let fm: Record<string, unknown>;
      try {
        fm = yamlParse(parts[1]) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (fm.attendance !== undefined && resolveAttendance(fm.attendance) === null) {
        throw new TasksError(
          "INVALID_ATTENDANCE",
          `task ${fm.uuid ?? filename} has invalid attendance: ${String(fm.attendance)}. Allowed: ${ATTENDANCE_VALUES.join(", ")}`,
          { uuid: fm.uuid, value: fm.attendance, allowed: [...ATTENDANCE_VALUES] },
        );
      }
      if (fm.effort !== undefined && resolveEffort(fm.effort) === null) {
        throw new TasksError(
          "INVALID_EFFORT",
          `task ${fm.uuid ?? filename} has invalid effort: ${String(fm.effort)}. Allowed: ${EFFORT_VALUES.join(", ")}`,
          { uuid: fm.uuid, value: fm.effort, allowed: [...EFFORT_VALUES] },
        );
      }
    }
  }
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
 * Return all tasks in the store, grouped by column in canonical order
 * (backlog, ready, doing, blocked, review, done), and within each column
 * sorted by filename (which starts with the numeric id, giving stable ordering).
 *
 * Returns an empty array if the store does not exist.
 * Does NOT auto-initialize the store.
 */
export function findAllTasks(dir: string): TaskData[] {
  if (!existsSync(dir)) {
    return [];
  }

  const results: TaskData[] = [];

  for (const col of COLUMNS) {
    const colDir = join(dir, col);
    if (!existsSync(colDir)) continue;

    let files: string[];
    try {
      files = readdirSync(colDir)
        .filter((f) => f.endsWith(".md"))
        .sort(); // lexicographic = id-ascending for numeric-prefixed filenames
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
      if (typeof fm.id !== "number") continue; // skip unparseable files

      results.push({
        id: fm.id as number,
        uuid: fm.uuid as string,
        title: fm.title as string,
        column: col,
        created_at: fm.created_at as string,
        updated_at: fm.updated_at as string,
        body,
        deps: Array.isArray(fm.deps) ? (fm.deps as string[]) : [],
        attendance: resolveAttendance(fm.attendance) ?? DEFAULT_ATTENDANCE,
        effort: resolveEffort(fm.effort) ?? DEFAULT_EFFORT,
      });
    }
  }

  return results;
}

/**
 * Return all tasks currently in the `archive/` sibling directory.
 *
 * Same parsing rules as `findAllTasks`, but the resulting TaskData carries
 * `column: "archive"` so callers can filter or treat them specially.
 * Returns an empty array if the store or archive/ directory does not exist.
 * Does NOT auto-initialize the store.
 */
export function findArchivedTasks(dir: string): TaskData[] {
  const archiveDir = join(dir, ARCHIVE_DIR);
  if (!existsSync(archiveDir)) return [];

  const results: TaskData[] = [];
  let files: string[];
  try {
    files = readdirSync(archiveDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }

  for (const filename of files) {
    let raw: string;
    try {
      raw = readFileSync(join(archiveDir, filename), "utf-8");
    } catch {
      continue;
    }
    const { fm, body } = parseTaskFile(raw);
    if (typeof fm.id !== "number") continue;
    results.push({
      id: fm.id as number,
      uuid: fm.uuid as string,
      title: fm.title as string,
      column: ARCHIVE_DIR,
      created_at: fm.created_at as string,
      updated_at: fm.updated_at as string,
      body,
      deps: Array.isArray(fm.deps) ? (fm.deps as string[]) : [],
      attendance: resolveAttendance(fm.attendance) ?? DEFAULT_ATTENDANCE,
      effort: resolveEffort(fm.effort) ?? DEFAULT_EFFORT,
    });
  }
  return results;
}

/**
 * Group an array of tasks by column into a Record with all six column keys.
 * Each key is always present (empty array if no tasks in that column).
 */
export function groupTasksByColumn(tasks: TaskData[]): Record<string, TaskData[]> {
  const grouped: Record<string, TaskData[]> = {};
  for (const col of COLUMNS) {
    grouped[col] = [];
  }
  for (const task of tasks) {
    if (grouped[task.column]) {
      grouped[task.column].push(task);
    }
  }
  return grouped;
}

/**
 * Move a task to a different column via `git mv`, bump `updated_at`, and commit.
 * - Same column: no-op (returns without committing).
 * - Unknown id/uuid: throws TasksError with code NOT_FOUND.
 *
 * Acquires flock. Honors dirty-tree guard (caller must check outside if desired;
 * this also checks inside the lock for the definitive guard).
 */
export async function moveTask(dir: string, idOrUuid: string, targetColumn: string): Promise<void> {
  return withLock(dir, async () => {
    // Dirty-tree guard inside the lock (definitive check)
    if (await isStoreDirty(dir)) {
      throw new TasksError(
        "STORE_DIRTY",
        "store working tree is dirty; commit or discard pending changes before running mutating commands",
        {}
      );
    }

    // Reject if any existing task file carries an invalid enum value.
    validateEnums(dir);

    // Find the task
    const task = findTask(dir, idOrUuid);
    if (!task) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }

    // Same-column no-op
    if (task.column === targetColumn) {
      return;
    }

    // Determine old and new paths. Need to find the actual filename.
    const colDir = join(dir, task.column);
    const files = readdirSync(colDir).filter((f) => f.endsWith(".md"));
    const byShortId = /^\d+$/.test(idOrUuid);
    const targetId = byShortId ? parseInt(idOrUuid, 10) : null;

    let filename: string | null = null;
    for (const f of files) {
      const raw = readFileSync(join(colDir, f), "utf-8");
      const parts = raw.split(/^---\s*$/m);
      if (parts.length < 3) continue;
      const fm = yamlParse(parts[1]) as Record<string, unknown>;
      const matches = byShortId ? fm.id === targetId : fm.uuid === idOrUuid;
      if (matches) {
        filename = f;
        break;
      }
    }

    if (!filename) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }

    const oldRelPath = `${task.column}/${filename}`;
    const newRelPath = `${targetColumn}/${filename}`;
    const newFilePath = join(dir, targetColumn, filename);

    // Bump updated_at in the file content before moving
    const oldFilePath = join(dir, task.column, filename);
    const raw = readFileSync(oldFilePath, "utf-8");
    const now = new Date().toISOString();
    const updated = raw.replace(
      /^(updated_at:\s*)(.+)$/m,
      `$1${now}`
    );

    // Write updated content to new location, remove old file
    writeFileSync(newFilePath, updated, "utf-8");
    // Use git mv to move (we wrote the new file already, so we need to do this differently:
    // write to new path, then git rm old + git add new)
    // Actually: write to temp new, then use git mv + overwrite approach is tricky.
    // Simpler: write new content to new path, then git rm old, git add new.
    // But we already wrote newFilePath above - need to remove oldFilePath first so git mv works.
    // Let's do: update in place, then git mv.

    // Re-approach: update file in place (old path), then git mv old -> new
    writeFileSync(oldFilePath, updated, "utf-8");
    // Remove the file we wrote to new path
    const { unlinkSync } = await import("node:fs");
    unlinkSync(newFilePath);

    // Stage the content update (modified in old location)
    await git(["add", oldRelPath], dir);

    // git mv old -> new
    const mvExit = await git(["mv", oldRelPath, newRelPath], dir);
    if (mvExit !== 0) {
      throw new TasksError("GIT_ERROR", `git mv failed`, {});
    }

    // Commit
    await git(["commit", "-m", `task: mv #${task.id} ${task.column} -> ${targetColumn}`], dir);
  });
}

/**
 * Remove a task from the store via `git rm` and commit atomically.
 * - Unknown id/uuid: throws TasksError with code NOT_FOUND.
 * - If `force` is false and any task depends on this task: throws TasksError with code DEP_EXISTS.
 * - If `force` is true: strips the target uuid from all dependents' deps arrays,
 *   git-adds those modified files, then git-rms the target, all in ONE commit.
 *   Returns affected (modified) dependent tasks.
 *
 * Acquires flock. Honors dirty-tree guard.
 */
export async function removeTask(
  dir: string,
  idOrUuid: string,
  force: boolean = false,
): Promise<{ task: TaskData; affected: TaskData[] }> {
  return withLock(dir, async () => {
    // Dirty-tree guard inside the lock (definitive check)
    if (await isStoreDirty(dir)) {
      throw new TasksError(
        "STORE_DIRTY",
        "store working tree is dirty; commit or discard pending changes before running mutating commands",
        {}
      );
    }

    // Reject if any existing task file carries an invalid enum value.
    validateEnums(dir);

    // Find the task
    const task = findTask(dir, idOrUuid);
    if (!task) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }

    // Find all tasks whose deps include this task's uuid
    const allTasks = findAllTasks(dir);
    const dependents = allTasks.filter((t) => t.deps.includes(task.uuid));

    if (!force && dependents.length > 0) {
      throw new TasksError(
        "DEP_EXISTS",
        `task #${task.id} is depended on by ${dependents.length} task(s); use --force to delete and strip references`,
        { dependents: dependents.map((t) => ({ id: t.id, uuid: t.uuid, title: t.title })) },
      );
    }

    // Determine the filename of the task to remove
    const colDir = join(dir, task.column);
    const files = readdirSync(colDir).filter((f) => f.endsWith(".md"));
    const byShortId = /^\d+$/.test(idOrUuid);
    const targetId = byShortId ? parseInt(idOrUuid, 10) : null;

    let filename: string | null = null;
    for (const f of files) {
      const raw = readFileSync(join(colDir, f), "utf-8");
      const parts = raw.split(/^---\s*$/m);
      if (parts.length < 3) continue;
      const fm = yamlParse(parts[1]) as Record<string, unknown>;
      const matches = byShortId ? fm.id === targetId : fm.uuid === idOrUuid;
      if (matches) {
        filename = f;
        break;
      }
    }

    if (!filename) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }

    // If force: strip the target uuid from each dependent's deps, rewrite + stage
    if (force && dependents.length > 0) {
      for (const dep of dependents) {
        const loc = findTaskFilename(dir, String(dep.uuid));
        if (!loc) continue;
        const depFilePath = join(dir, loc.column, loc.filename);
        const raw = readFileSync(depFilePath, "utf-8");
        const parts = raw.split(/^---\s*$/m);
        if (parts.length < 3) continue;
        const fm = yamlParse(parts[1]) as Record<string, unknown>;
        const oldDeps = Array.isArray(fm.deps) ? (fm.deps as string[]) : [];
        const newDeps = oldDeps.filter((u) => u !== task.uuid);
        fm.deps = newDeps;
        // Reconstruct file content: regenerate frontmatter with updated deps
        // Replace only the deps line to preserve other field order/quoting
        const depsYaml = newDeps.length === 0
          ? "[]"
          : `[${newDeps.map((u) => `"${u}"`).join(", ")}]`;
        const newFmStr = parts[1].replace(/^deps:.*$/m, `deps: ${depsYaml}`);
        const newContent = `---${newFmStr}---${parts.slice(2).join("---")}`;
        writeFileSync(depFilePath, newContent, "utf-8");
        await git(["add", `${loc.column}/${loc.filename}`], dir);
      }
    }

    const relPath = `${task.column}/${filename}`;

    // git rm and commit (includes any staged dependent rewrites)
    const rmExit = await git(["rm", relPath], dir);
    if (rmExit !== 0) {
      throw new TasksError("GIT_ERROR", `git rm failed`, {});
    }

    await git(["commit", "-m", `task: rm #${task.id}: ${task.title}`], dir);

    return { task, affected: dependents };
  });
}

export interface ArchiveOptions {
  /** Single-task form: archive only this task (must be in `done/`). */
  idOrUuid?: string;
  /** Bulk form: archive done/ tasks whose `updated_at` is strictly before this instant. */
  before?: Date;
}

/**
 * Archive tasks: `git mv` them from `done/` into the `archive/` sibling
 * directory. Three forms:
 *   - no opts: archive every task currently in `done/`.
 *   - `before`: archive `done/` tasks older than the cutoff (by `updated_at`).
 *   - `idOrUuid`: archive that single task; rejects with INVALID_COLUMN if the
 *     task isn't in `done/`.
 * On a non-empty target set, produces exactly one commit covering every move
 * and the `updated_at` bumps. Empty target set is a no-op (no commit).
 *
 * Acquires flock. Honors dirty-tree guard.
 */
export async function archiveTasks(
  dir: string,
  opts: ArchiveOptions = {},
): Promise<{ archived: TaskData[] }> {
  return withLock(dir, async () => {
    if (await isStoreDirty(dir)) {
      throw new TasksError(
        "STORE_DIRTY",
        "store working tree is dirty; commit or discard pending changes before running mutating commands",
        {},
      );
    }
    validateEnums(dir);

    let targets: TaskData[];
    if (opts.idOrUuid) {
      const t = findTask(dir, opts.idOrUuid);
      if (!t) {
        throw new TasksError("NOT_FOUND", `task not found: ${opts.idOrUuid}`, { id: opts.idOrUuid });
      }
      if (t.column !== "done") {
        throw new TasksError(
          "INVALID_COLUMN",
          `task #${t.id} is in '${t.column}', not 'done'; only done/ tasks can be archived`,
          { column: t.column, id: t.id, uuid: t.uuid },
        );
      }
      targets = [t];
    } else {
      const doneTasks = findAllTasks(dir).filter((t) => t.column === "done");
      if (opts.before) {
        const cutoff = opts.before.getTime();
        targets = doneTasks.filter((t) => new Date(t.updated_at).getTime() < cutoff);
      } else {
        targets = doneTasks;
      }
    }

    if (targets.length === 0) {
      return { archived: [] };
    }

    mkdirSync(join(dir, ARCHIVE_DIR), { recursive: true });

    const now = new Date().toISOString();
    for (const task of targets) {
      const loc = findTaskFilename(dir, String(task.uuid));
      if (!loc) continue;
      const oldRelPath = `${loc.column}/${loc.filename}`;
      const newRelPath = `${ARCHIVE_DIR}/${loc.filename}`;
      const oldFilePath = join(dir, loc.column, loc.filename);
      const raw = readFileSync(oldFilePath, "utf-8");
      const updated = raw.replace(/^(updated_at:\s*)(.+)$/m, `$1${now}`);
      writeFileSync(oldFilePath, updated, "utf-8");
      await git(["add", oldRelPath], dir);
      const mvExit = await git(["mv", oldRelPath, newRelPath], dir);
      if (mvExit !== 0) {
        throw new TasksError("GIT_ERROR", `git mv failed`, {});
      }
    }

    const subject = targets.length === 1
      ? `task: archive #${targets[0].id}: ${targets[0].title}`
      : `task: archive ${targets.length} tasks from done`;
    await git(["commit", "-m", subject], dir);

    return { archived: targets };
  });
}

/**
 * Locate the on-disk filename for a task by short id or UUID.
 * Returns null if not found.
 */
export function findTaskFilename(
  dir: string,
  idOrUuid: string,
): { column: string; filename: string } | null {
  if (!existsSync(dir)) return null;
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
    for (const f of files) {
      const raw = readFileSync(join(colDir, f), "utf-8");
      const parts = raw.split(/^---\s*$/m);
      if (parts.length < 3) continue;
      const fm = yamlParse(parts[1]) as Record<string, unknown>;
      const matches = byShortId ? fm.id === targetId : fm.uuid === idOrUuid;
      if (matches) return { column: col, filename: f };
    }
  }
  return null;
}

/**
 * Validate the dependency graph across all tasks in the store.
 *
 * Rules:
 *   - Every uuid referenced in a task's `deps` must correspond to an existing
 *     task in the store. Otherwise: throws TasksError(code=UNKNOWN_UUID).
 *   - The directed graph (edge: task -> dep) must be acyclic. A self-loop
 *     counts as a cycle. Otherwise: throws TasksError(code=CYCLE_DETECTED).
 *
 * Detection: iterative DFS with white/gray/black colors. The first offending
 * uuid (unknown or back-edge target) is surfaced in `details.uuid` for clearer
 * error envelopes.
 */
export function validateGraph(tasks: TaskData[]): void {
  const known = new Set(tasks.map((t) => t.uuid));

  // Unknown UUID check across all edges.
  for (const t of tasks) {
    for (const dep of t.deps) {
      if (!known.has(dep)) {
        throw new TasksError(
          "UNKNOWN_UUID",
          `task ${t.uuid} references unknown uuid: ${dep}`,
          { uuid: dep, referencedBy: t.uuid },
        );
      }
    }
  }

  // Cycle detection (DFS, white/gray/black).
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.uuid, WHITE);
  const adj = new Map<string, string[]>();
  for (const t of tasks) adj.set(t.uuid, t.deps);

  function dfs(start: string): string | null {
    const stack: { node: string; idx: number }[] = [{ node: start, idx: 0 }];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.idx >= neighbors.length) {
        color.set(frame.node, BLACK);
        stack.pop();
        continue;
      }
      const next = neighbors[frame.idx++];
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        return next; // back-edge → cycle
      }
      if (c === WHITE) {
        color.set(next, GRAY);
        stack.push({ node: next, idx: 0 });
      }
    }
    return null;
  }

  for (const t of tasks) {
    if ((color.get(t.uuid) ?? WHITE) === WHITE) {
      const cycleNode = dfs(t.uuid);
      if (cycleNode !== null) {
        throw new TasksError(
          "CYCLE_DETECTED",
          `dependency cycle detected involving uuid: ${cycleNode}`,
          { uuid: cycleNode },
        );
      }
    }
  }
}

/**
 * The validateTitle rules shared between `new` and `edit`.
 * Returns null if valid, or an error message otherwise.
 */
export function validateTitle(title: unknown): string | null {
  if (typeof title !== "string") return "title is required";
  if (title.trim() === "") return "title is required";
  if (/[\n\r]/.test(title)) return "title must be a single line (no newline characters)";
  if (title.length > 200) return `title must be 200 characters or fewer (got ${title.length})`;
  return null;
}

/**
 * Compute the on-disk slug for a title (exposed for `edit` so renames stay in
 * sync with `new`).
 */
export function titleSlug(title: string): string {
  return slugify(title);
}

/**
 * `tasks edit --abort`: discard all pending working-tree changes in the store
 * and reset to HEAD. Does NOT acquire the flock; abort is a recovery path.
 */
export async function abortPendingEdits(dir: string): Promise<void> {
  if (!existsSync(join(dir, ".git"))) return;
  await git(["checkout", "--", "."], dir);
}

/**
 * The editor-runner contract. The runner is given the absolute path to the
 * task file and should return the editor's exit code. Throwing is allowed and
 * surfaced as EDITOR_FAILED by the caller.
 */
export type EditorRunner = (filePath: string) => Promise<number>;

/**
 * Edit a task by round-tripping through `$EDITOR` (via the injected runner).
 *
 * Returns a discriminated outcome:
 *   - { kind: "noop" }: file unchanged after the editor exited.
 *   - { kind: "committed", titleChanged }: file changed, validated, committed.
 *
 * Errors throw TasksError with codes: NOT_FOUND, EDITOR_FAILED, INVALID_TITLE.
 * On INVALID_TITLE the bad file is left as-is on disk per PRD.
 *
 * Exempt from the STORE_DIRTY guard. Acquires the flock.
 */
export async function editTask(
  dir: string,
  idOrUuid: string,
  runEditor: EditorRunner,
): Promise<{ kind: "noop" } | { kind: "committed"; titleChanged: boolean }> {
  return withLock(dir, async () => {
    // Reject if any existing task file (other than the editing one) carries
    // an invalid enum value. The edit path itself may set new values; those
    // are validated post-save below.
    validateEnums(dir);

    const loc = findTaskFilename(dir, idOrUuid);
    if (!loc) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }
    const { column, filename } = loc;
    const filePath = join(dir, column, filename);
    const before = readFileSync(filePath, "utf-8");

    // Run editor. Any throw or non-zero exit → EDITOR_FAILED.
    let exit: number;
    try {
      exit = await runEditor(filePath);
    } catch (err) {
      throw new TasksError(
        "EDITOR_FAILED",
        `editor failed: ${err instanceof Error ? err.message : String(err)}`,
        {},
      );
    }
    if (exit !== 0) {
      throw new TasksError("EDITOR_FAILED", `editor exited with code ${exit}`, { exit });
    }

    const after = readFileSync(filePath, "utf-8");
    if (after === before) {
      return { kind: "noop" };
    }

    // Parse and validate. Bad title → leave file as-is, throw.
    const parts = after.split(/^---\s*$/m);
    if (parts.length < 3) {
      throw new TasksError("INVALID_TITLE", "task file is missing YAML frontmatter", {});
    }
    let fm: Record<string, unknown>;
    try {
      fm = yamlParse(parts[1]) as Record<string, unknown>;
    } catch (err) {
      throw new TasksError(
        "INVALID_TITLE",
        `invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        {},
      );
    }
    const titleErr = validateTitle(fm.title);
    if (titleErr !== null) {
      throw new TasksError("INVALID_TITLE", titleErr, {});
    }

    const oldFm = yamlParse((before.split(/^---\s*$/m))[1]) as Record<string, unknown>;
    const oldTitle = oldFm.title as string;
    const newTitle = fm.title as string;
    const titleChanged = oldTitle !== newTitle;

    // Bump updated_at on the new content.
    const now = new Date().toISOString();
    let bumped = after.replace(/^(updated_at:\s*)(.+)$/m, `$1${now}`);
    if (!/^updated_at:/m.test(bumped)) {
      // Insert into frontmatter just before closing ---
      const fmEndIdx = bumped.indexOf("\n---", bumped.indexOf("---") + 3);
      if (fmEndIdx !== -1) {
        bumped = bumped.slice(0, fmEndIdx) + `\nupdated_at: ${now}` + bumped.slice(fmEndIdx);
      }
    }

    // If updated_at bump resulted in identical content (rare; e.g. user already
    // set updated_at to now), still proceed since other content differs.
    writeFileSync(filePath, bumped, "utf-8");

    // Validate enum fields on the just-saved file (post-mutation state).
    // Leaves the bad file on disk so `tasks edit --abort` or re-edit recovers.
    if (fm.attendance !== undefined && resolveAttendance(fm.attendance) === null) {
      throw new TasksError(
        "INVALID_ATTENDANCE",
        `invalid attendance: ${String(fm.attendance)}. Allowed: ${ATTENDANCE_VALUES.join(", ")}`,
        { value: fm.attendance, allowed: [...ATTENDANCE_VALUES] },
      );
    }
    if (fm.effort !== undefined && resolveEffort(fm.effort) === null) {
      throw new TasksError(
        "INVALID_EFFORT",
        `invalid effort: ${String(fm.effort)}. Allowed: ${EFFORT_VALUES.join(", ")}`,
        { value: fm.effort, allowed: [...EFFORT_VALUES] },
      );
    }

    // Validate the graph across all on-disk tasks (post-mutation state). If
    // validation fails, leave the bad file on disk (mirrors INVALID_TITLE) so
    // the user can `tasks edit --abort` or re-edit in place; do not commit.
    validateGraph(findAllTasks(dir));

    const oldRelPath = `${column}/${filename}`;

    if (titleChanged) {
      const newSlug = slugify(newTitle);
      const id = oldFm.id as number;
      const newFilename = `${id}-${newSlug}.md`;
      const newRelPath = `${column}/${newFilename}`;
      const newFilePath = join(dir, column, newFilename);

      if (newFilename !== filename) {
        // Stage the content modification first so git mv sees the modified content.
        await git(["add", oldRelPath], dir);
        const mvExit = await git(["mv", oldRelPath, newRelPath], dir);
        if (mvExit !== 0) {
          // Fall back: manual rename + git add/rm
          renameSync(filePath, newFilePath);
          await git(["rm", oldRelPath], dir);
          await git(["add", newRelPath], dir);
        }
      } else {
        // Slug unchanged (title differs only in case/punctuation that maps to same slug)
        await git(["add", oldRelPath], dir);
      }
    } else {
      await git(["add", oldRelPath], dir);
    }

    // Commit ONLY what's staged for this task; leaves any pre-existing dirty
    // tree alone (PRD: edit is exempt from STORE_DIRTY).
    await git(["commit", "-m", `task: edit #${oldFm.id}`], dir);

    return { kind: "committed", titleChanged };
  });
}

/**
 * Add dependency edges from `subjectRef` to each UUID in `targetRefs`.
 *
 * - Resolves both the subject and each target by short id or UUID.
 * - Self-link is rejected with SELF_LINK before graph validation.
 * - Deduplicates: targets already present in deps are silently skipped.
 * - Runs validateGraph() after tentatively applying the new edges so
 *   UNKNOWN_UUID and CYCLE_DETECTED errors surface naturally.
 * - If no new edges would be added (all already present), still exits 0
 *   but makes no commit (no-op, matching mv same-column behavior).
 * - Otherwise: writes the updated frontmatter and commits once.
 * - Bumps updated_at on the subject task.
 *
 * Acquires flock. Honors dirty-tree guard.
 */
export async function linkTask(
  dir: string,
  subjectRef: string,
  targetRefs: string[],
): Promise<void> {
  return withLock(dir, async () => {
    // Dirty-tree guard inside the lock (definitive check)
    if (await isStoreDirty(dir)) {
      throw new TasksError(
        "STORE_DIRTY",
        "store working tree is dirty; commit or discard pending changes before running mutating commands",
        {}
      );
    }

    // Reject if any existing task file carries an invalid enum value.
    validateEnums(dir);

    // Resolve subject
    const subject = findTask(dir, subjectRef);
    if (!subject) {
      throw new TasksError("NOT_FOUND", `task not found: ${subjectRef}`, { id: subjectRef });
    }

    // Resolve each target ref to a UUID (may be short id or UUID already)
    const allTasks = findAllTasks(dir);
    const knownByUuid = new Map(allTasks.map((t) => [t.uuid, t]));
    const knownById = new Map(allTasks.map((t) => [t.id, t]));

    const resolvedTargetUuids: string[] = [];
    for (const ref of targetRefs) {
      let targetTask: TaskData | undefined;
      if (/^\d+$/.test(ref)) {
        targetTask = knownById.get(parseInt(ref, 10));
      } else {
        targetTask = knownByUuid.get(ref);
      }

      if (!targetTask) {
        // If not resolved by short id or direct UUID lookup, throw UNKNOWN_UUID.
        // (validateGraph would catch it too, but we want a clear error here.)
        throw new TasksError(
          "UNKNOWN_UUID",
          `target not found: ${ref}`,
          { uuid: ref }
        );
      }

      // Self-link check
      if (targetTask.uuid === subject.uuid) {
        throw new TasksError(
          "SELF_LINK",
          `task cannot depend on itself: ${subject.uuid}`,
          { uuid: subject.uuid }
        );
      }

      resolvedTargetUuids.push(targetTask.uuid);
    }

    // Determine new edges (deduplicate against existing deps)
    const existingDeps = new Set(subject.deps);
    const newEdges = resolvedTargetUuids.filter((u) => !existingDeps.has(u));

    // No-op: all targets already in deps
    if (newEdges.length === 0) {
      return;
    }

    // Tentatively apply edges and validate the graph
    const updatedDeps = [...subject.deps, ...newEdges];

    // Build a temporary tasks snapshot with the updated deps for validation
    const mutatedTasks = allTasks.map((t) =>
      t.uuid === subject.uuid ? { ...t, deps: updatedDeps } : t
    );
    validateGraph(mutatedTasks);

    // Find the subject file on disk
    const loc = findTaskFilename(dir, subject.uuid);
    if (!loc) {
      throw new TasksError("NOT_FOUND", `task not found: ${subjectRef}`, { id: subjectRef });
    }
    const filePath = join(dir, loc.column, loc.filename);
    const raw = readFileSync(filePath, "utf-8");
    const parts = raw.split(/^---\s*$/m);
    if (parts.length < 3) {
      throw new TasksError("INVALID_TITLE", "task file is missing YAML frontmatter", {});
    }

    // Rewrite deps line in frontmatter and bump updated_at
    const depsYaml =
      updatedDeps.length === 0
        ? "[]"
        : `[${updatedDeps.map((u) => `"${u}"`).join(", ")}]`;
    const now = new Date().toISOString();
    let newFm = parts[1].replace(/^deps:.*$/m, `deps: ${depsYaml}`);
    newFm = newFm.replace(/^(updated_at:\s*)(.+)$/m, `$1${now}`);
    const newContent = `---${newFm}---${parts.slice(2).join("---")}`;
    writeFileSync(filePath, newContent, "utf-8");

    const relPath = `${loc.column}/${loc.filename}`;
    await git(["add", relPath], dir);
    await git(["commit", "-m", `task: link #${subject.id} depends-on ${newEdges.map((u) => `${u.slice(0, 8)}`).join(", ")}`], dir);
  });
}

/**
 * Remove dependency edges from `subjectRef` for each UUID in `targetRefs`.
 *
 * - Resolves both the subject and each target by short id or UUID.
 * - Self-unlink is rejected with SELF_LINK (mirrors link's behavior).
 * - Targets that resolve to a real task but are not currently in deps are
 *   silently ignored (idempotent).
 * - Unknown target ref (resolves to no task) throws UNKNOWN_UUID.
 * - If no edges would change (all targets absent), exits 0 with no commit.
 * - Otherwise: writes updated frontmatter, bumps updated_at, commits once.
 * - Runs validateGraph() after the mutation for consistency.
 *
 * Acquires flock. Honors dirty-tree guard.
 */
export async function unlinkTask(
  dir: string,
  subjectRef: string,
  targetRefs: string[],
): Promise<void> {
  return withLock(dir, async () => {
    // Dirty-tree guard inside the lock (definitive check)
    if (await isStoreDirty(dir)) {
      throw new TasksError(
        "STORE_DIRTY",
        "store working tree is dirty; commit or discard pending changes before running mutating commands",
        {}
      );
    }

    // Reject if any existing task file carries an invalid enum value.
    validateEnums(dir);

    // Resolve subject
    const subject = findTask(dir, subjectRef);
    if (!subject) {
      throw new TasksError("NOT_FOUND", `task not found: ${subjectRef}`, { id: subjectRef });
    }

    // Resolve each target ref to a UUID
    const allTasks = findAllTasks(dir);
    const knownByUuid = new Map(allTasks.map((t) => [t.uuid, t]));
    const knownById = new Map(allTasks.map((t) => [t.id, t]));

    const resolvedTargetUuids: string[] = [];
    for (const ref of targetRefs) {
      let targetTask: TaskData | undefined;
      if (/^\d+$/.test(ref)) {
        targetTask = knownById.get(parseInt(ref, 10));
      } else {
        targetTask = knownByUuid.get(ref);
      }

      if (!targetTask) {
        throw new TasksError(
          "UNKNOWN_UUID",
          `target not found: ${ref}`,
          { uuid: ref }
        );
      }

      // Self-unlink check (mirrors link's SELF_LINK behavior)
      if (targetTask.uuid === subject.uuid) {
        throw new TasksError(
          "SELF_LINK",
          `task cannot unlink itself: ${subject.uuid}`,
          { uuid: subject.uuid }
        );
      }

      resolvedTargetUuids.push(targetTask.uuid);
    }

    // Compute new deps by removing the resolved targets
    const removeSet = new Set(resolvedTargetUuids);
    const updatedDeps = subject.deps.filter((u) => !removeSet.has(u));

    // No-op: deps unchanged (no target was actually in deps)
    if (updatedDeps.length === subject.deps.length) {
      return;
    }

    // Validate the graph post-mutation for consistency
    const mutatedTasks = allTasks.map((t) =>
      t.uuid === subject.uuid ? { ...t, deps: updatedDeps } : t
    );
    validateGraph(mutatedTasks);

    // Find the subject file on disk
    const loc = findTaskFilename(dir, subject.uuid);
    if (!loc) {
      throw new TasksError("NOT_FOUND", `task not found: ${subjectRef}`, { id: subjectRef });
    }
    const filePath = join(dir, loc.column, loc.filename);
    const raw = readFileSync(filePath, "utf-8");
    const parts = raw.split(/^---\s*$/m);
    if (parts.length < 3) {
      throw new TasksError("INVALID_TITLE", "task file is missing YAML frontmatter", {});
    }

    // Rewrite deps line in frontmatter and bump updated_at
    const depsYaml =
      updatedDeps.length === 0
        ? "[]"
        : `[${updatedDeps.map((u) => `"${u}"`).join(", ")}]`;
    const now = new Date().toISOString();
    let newFm = parts[1].replace(/^deps:.*$/m, `deps: ${depsYaml}`);
    newFm = newFm.replace(/^(updated_at:\s*)(.+)$/m, `$1${now}`);
    const newContent = `---${newFm}---${parts.slice(2).join("---")}`;
    writeFileSync(filePath, newContent, "utf-8");

    const relPath = `${loc.column}/${loc.filename}`;
    await git(["add", relPath], dir);
    const removedUuids = subject.deps.filter((u) => removeSet.has(u));
    await git(["commit", "-m", `task: unlink #${subject.id} remove ${removedUuids.map((u) => u.slice(0, 8)).join(", ")}`], dir);
  });
}

/**
 * Options for `setTask`. At least one field must be supplied; the caller
 * (CLI) is responsible for surfacing MISSING_FIELD when nothing is passed.
 */
export interface SetTaskOptions {
  title?: string;
  attendance?: "attended" | "unattended";
  effort?: "low" | "medium" | "high";
}

/**
 * Scalar setter for the three fields a single command can change cleanly.
 *
 * - Applies all provided fields and commits in ONE commit.
 * - `--title` recomputes the slug and performs the content update plus
 *   `git mv` in the same commit (matches `editTask` title-change semantics).
 * - `--attendance` and `--effort` enum values are pre-validated by the caller
 *   (so callers can choose human or JSON error envelopes); this function
 *   additionally re-validates to guard internal callers.
 * - `--title` is validated via the shared `validateTitle`.
 * - Bumps `updated_at`.
 *
 * Acquires flock. Honors the dirty-tree guard inside the lock.
 */
export async function setTask(
  dir: string,
  idOrUuid: string,
  opts: SetTaskOptions,
): Promise<void> {
  return withLock(dir, async () => {
    // Dirty-tree guard inside the lock (definitive check)
    if (await isStoreDirty(dir)) {
      throw new TasksError(
        "STORE_DIRTY",
        "store working tree is dirty; commit or discard pending changes before running mutating commands",
        {}
      );
    }

    // Reject if any existing task file carries an invalid enum value.
    validateEnums(dir);

    // Validate inputs.
    if (opts.title !== undefined) {
      const err = validateTitle(opts.title);
      if (err !== null) {
        throw new TasksError("INVALID_TITLE", err, {});
      }
    }
    if (opts.attendance !== undefined && resolveAttendance(opts.attendance) === null) {
      throw new TasksError(
        "INVALID_ATTENDANCE",
        `invalid attendance: ${String(opts.attendance)}. Allowed: ${ATTENDANCE_VALUES.join(", ")}`,
        { value: opts.attendance, allowed: [...ATTENDANCE_VALUES] },
      );
    }
    if (opts.effort !== undefined && resolveEffort(opts.effort) === null) {
      throw new TasksError(
        "INVALID_EFFORT",
        `invalid effort: ${String(opts.effort)}. Allowed: ${EFFORT_VALUES.join(", ")}`,
        { value: opts.effort, allowed: [...EFFORT_VALUES] },
      );
    }

    // Find the task on disk.
    const loc = findTaskFilename(dir, idOrUuid);
    if (!loc) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }
    const { column, filename } = loc;
    const filePath = join(dir, column, filename);
    const raw = readFileSync(filePath, "utf-8");
    const parts = raw.split(/^---\s*$/m);
    if (parts.length < 3) {
      throw new TasksError("INVALID_TITLE", "task file is missing YAML frontmatter", {});
    }
    const oldFm = yamlParse(parts[1]) as Record<string, unknown>;
    const id = oldFm.id as number;
    const oldTitle = oldFm.title as string;

    // Build the new frontmatter text by substituting individual lines (preserve
    // formatting/order of unrelated keys).
    let newFm = parts[1];
    if (opts.title !== undefined) {
      // Replace the title line. Use a JSON-encoded scalar so colons/quotes in
      // the title round-trip cleanly through yamlParse on the next read.
      const encoded = JSON.stringify(opts.title);
      newFm = newFm.replace(/^title:.*$/m, `title: ${encoded}`);
    }
    if (opts.attendance !== undefined) {
      if (/^attendance:/m.test(newFm)) {
        newFm = newFm.replace(/^attendance:.*$/m, `attendance: ${opts.attendance}`);
      } else {
        // Append before trailing newline of frontmatter block.
        newFm = newFm.replace(/\n?$/, `\nattendance: ${opts.attendance}\n`);
      }
    }
    if (opts.effort !== undefined) {
      if (/^effort:/m.test(newFm)) {
        newFm = newFm.replace(/^effort:.*$/m, `effort: ${opts.effort}`);
      } else {
        newFm = newFm.replace(/\n?$/, `\neffort: ${opts.effort}\n`);
      }
    }
    // Bump updated_at.
    const now = new Date().toISOString();
    if (/^updated_at:/m.test(newFm)) {
      newFm = newFm.replace(/^(updated_at:\s*)(.+)$/m, `$1${now}`);
    } else {
      newFm = newFm.replace(/\n?$/, `\nupdated_at: ${now}\n`);
    }

    const newContent = `---${newFm}---${parts.slice(2).join("---")}`;
    writeFileSync(filePath, newContent, "utf-8");

    const oldRelPath = `${column}/${filename}`;
    const titleChanged = opts.title !== undefined && opts.title !== oldTitle;

    if (titleChanged) {
      const newSlug = slugify(opts.title as string);
      const newFilename = `${id}-${newSlug}.md`;
      const newRelPath = `${column}/${newFilename}`;
      const newFilePath = join(dir, column, newFilename);

      if (newFilename !== filename) {
        // Stage the content modification first so `git mv` sees it.
        await git(["add", oldRelPath], dir);
        const mvExit = await git(["mv", oldRelPath, newRelPath], dir);
        if (mvExit !== 0) {
          // Fall back: manual rename + git add/rm
          renameSync(filePath, newFilePath);
          await git(["rm", oldRelPath], dir);
          await git(["add", newRelPath], dir);
        }
      } else {
        await git(["add", oldRelPath], dir);
      }
    } else {
      await git(["add", oldRelPath], dir);
    }

    // Build a descriptive commit message listing which fields changed.
    const changed: string[] = [];
    if (opts.title !== undefined) changed.push("title");
    if (opts.attendance !== undefined) changed.push("attendance");
    if (opts.effort !== undefined) changed.push("effort");
    await git(["commit", "-m", `task: set #${id} ${changed.join(", ")}`], dir);
  });
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
          attendance: resolveAttendance(fm.attendance) ?? DEFAULT_ATTENDANCE,
          effort: resolveEffort(fm.effort) ?? DEFAULT_EFFORT,
        };
      }
    }
  }

  return null;
}

/**
 * Run `git -C <dir> <args>` capturing stdout/stderr. Returns trimmed stdout
 * when exit code is 0; throws otherwise with the combined stderr.
 */
async function gitCapture(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

/**
 * Revert the most recent commit in the store with `git revert --no-edit HEAD`.
 *
 * Refuses with NOTHING_TO_UNDO when HEAD is the root (auto-init seed) commit,
 * detected by comparing `git rev-parse HEAD` against
 * `git rev-list --max-parents=0 HEAD`.
 *
 * Returns the SHA of the revert commit (now HEAD) on success.
 */
export async function undoStore(dir: string): Promise<{ revertSha: string; revertedSha: string }> {
  return withLock(dir, async () => {
    if (await isStoreDirty(dir)) {
      throw new TasksError(
        "STORE_DIRTY",
        "store working tree is dirty; commit or discard pending changes before running mutating commands",
        {}
      );
    }

    const head = await gitCapture(dir, ["rev-parse", "HEAD"]);
    const root = await gitCapture(dir, ["rev-list", "--max-parents=0", "HEAD"]);

    if (head === root) {
      throw new TasksError(
        "NOTHING_TO_UNDO",
        "nothing to undo: store has no mutations beyond the initial commit",
        {}
      );
    }

    const proc = Bun.spawn(["git", "-C", dir, "revert", "--no-edit", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (code !== 0) {
      // Best-effort cleanup so the working tree is not left mid-revert.
      const abort = Bun.spawn(["git", "-C", dir, "revert", "--abort"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await abort.exited;
      throw new TasksError(
        "UNDO_FAILED",
        `git revert failed: ${stderr.trim() || stdout.trim()}`,
        {}
      );
    }

    const revertSha = await gitCapture(dir, ["rev-parse", "HEAD"]);
    return { revertSha, revertedSha: head };
  });
}
