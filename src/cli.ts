#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { storeDir, ensureStore, createTask, isStoreDirty, resolveStoreDir, findTask, findAllTasks, groupTasksByColumn, findFlockOrFail, TasksError, COLUMNS } from "./store.ts";
import { renderTask, renderList, renderBoard } from "./render.ts";

/**
 * Write a JSON error envelope to stderr.
 * Shape: { "error": { "code": string, "message": string, "details": object } }
 */
function writeJsonError(code: string, message: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ error: { code, message, details } }) + "\n");
}

/**
 * Write a plain-text error to stderr.
 */
function writePlainError(message: string): void {
  process.stderr.write(`tasks: ${message}\n`);
}

/**
 * Validate a task title. Returns null on success, or an error message string.
 * Constraints: non-empty, single line (no newline characters), max 200 characters.
 */
function validateTitle(title: string): string | null {
  if (!title || title.trim() === "") {
    return "title is required";
  }
  if (/[\n\r]/.test(title)) {
    return "title must be a single line (no newline characters)";
  }
  if (title.length > 200) {
    return `title must be 200 characters or fewer (got ${title.length})`;
  }
  return null;
}

const args = process.argv.slice(2);
const [command, ...rest] = args;

if (command === "new") {
  const jsonFlag = rest.includes("--json");
  const title = rest.find((a) => a !== "--json") ?? "";
  const titleError = validateTitle(title);
  if (titleError !== null) {
    process.stderr.write(`tasks: INVALID_TITLE: ${titleError}\n`);
    process.exit(1);
  }

  // Check flock availability BEFORE any store/git work.
  try {
    findFlockOrFail();
  } catch (err) {
    if (err instanceof TasksError) {
      if (jsonFlag) {
        writeJsonError(err.code, err.message, err.details);
      } else {
        process.stderr.write(`${err.message}\n`);
      }
      process.exit(1);
    }
    throw err;
  }

  const dir = storeDir(process.cwd());
  await ensureStore(dir);

  // Dirty-tree guard: refuse to proceed if the store has uncommitted changes.
  // Runs after ensureStore so the git repo exists, and after the lock would be
  // acquired inside createTask. We check here (outside the lock) for an early,
  // clear error message; the definitive guard is inside createTask's withLock.
  if (await isStoreDirty(dir)) {
    const msg = "store working tree is dirty; commit or discard pending changes before running mutating commands";
    if (jsonFlag) {
      writeJsonError("STORE_DIRTY", msg, {});
    } else {
      process.stderr.write(`tasks: STORE_DIRTY: ${msg}\n`);
    }
    process.exit(1);
  }

  const id = await createTask(dir, title);
  process.stdout.write(`task: new #${id} — ${title}\n`);
} else if (command === "show") {
  // Determine whether --json was passed and get the id/uuid argument
  const jsonFlag = rest.includes("--json");
  const noColorFlag = rest.includes("--no-color");
  const idOrUuid = rest.find((a) => a !== "--json" && a !== "--no-color") ?? "";

  /**
   * Decide whether to emit ANSI color. Precedence:
   *   1. `--no-color` always wins (force off).
   *   2. `NO_COLOR` env var set to any value wins (force off).
   *   3. `FORCE_COLOR=1` forces on even when stdout is not a TTY.
   *   4. Otherwise: color iff stdout is a TTY.
   */
  function shouldColor(): boolean {
    if (noColorFlag) return false;
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
    if (process.env.FORCE_COLOR === "1") return true;
    return Boolean(process.stdout.isTTY);
  }

  if (!idOrUuid) {
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", "id or uuid is required", {});
    } else {
      writePlainError("MISSING_FIELD: id or uuid is required");
    }
    process.exit(1);
  }

  // Read-only: do NOT auto-init
  const dir = resolveStoreDir(process.cwd());
  const task = findTask(dir, idOrUuid);

  if (!task) {
    if (jsonFlag) {
      writeJsonError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    } else {
      writePlainError(`NOT_FOUND: task not found: ${idOrUuid}`);
    }
    process.exit(1);
  }

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(task) + "\n");
  } else {
    process.stdout.write(renderTask(task, { color: shouldColor() }));
  }
} else if (command === "list") {
  const jsonFlag = rest.includes("--json");
  const noColorFlag = rest.includes("--no-color");

  /**
   * Decide whether to emit ANSI color. Same precedence as `show`:
   *   1. `--no-color` always wins (force off).
   *   2. `NO_COLOR` env var set to any value wins (force off).
   *   3. `FORCE_COLOR=1` forces on even when stdout is not a TTY.
   *   4. Otherwise: color iff stdout is a TTY.
   */
  function shouldColor(): boolean {
    if (noColorFlag) return false;
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
    if (process.env.FORCE_COLOR === "1") return true;
    return Boolean(process.stdout.isTTY);
  }

  // Collect all --column <value> arguments (repeatable, OR-combine).
  const columnFilters: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--column" && i + 1 < rest.length) {
      columnFilters.push(rest[i + 1]);
      i++; // skip value token
    }
  }

  // Validate column names before touching the store.
  for (const col of columnFilters) {
    if (!COLUMNS.includes(col)) {
      const msg = `unknown column: ${col}. Valid columns: ${COLUMNS.join(", ")}`;
      if (jsonFlag) {
        writeJsonError("UNKNOWN_COLUMN", msg, { column: col, valid: COLUMNS });
      } else {
        writePlainError(`UNKNOWN_COLUMN: ${msg}`);
      }
      process.exit(1);
    }
  }

  // Read-only: do NOT auto-init. Return error if store does not exist.
  const dir = resolveStoreDir(process.cwd());

  if (!existsSync(dir)) {
    const msg = "store not initialized; run `tasks new` to create it";
    if (jsonFlag) {
      writeJsonError("NOT_INITIALIZED", msg, {});
    } else {
      writePlainError(`NOT_INITIALIZED: ${msg}`);
    }
    process.exit(1);
  }

  let tasks = findAllTasks(dir);

  // Apply column filter when one or more --column flags were given.
  if (columnFilters.length > 0) {
    tasks = tasks.filter((t) => columnFilters.includes(t.column));
  }

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(tasks) + "\n");
  } else {
    process.stdout.write(renderList(tasks, { color: shouldColor() }));
  }
} else if (command === "board") {
  const jsonFlag = rest.includes("--json");
  const noColorFlag = rest.includes("--no-color");

  function shouldColor(): boolean {
    if (noColorFlag) return false;
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
    if (process.env.FORCE_COLOR === "1") return true;
    return Boolean(process.stdout.isTTY);
  }

  // Read-only: do NOT auto-init. Return error if store does not exist.
  const dir = resolveStoreDir(process.cwd());

  if (!existsSync(dir)) {
    const msg = "store not initialized; run `tasks new` to create it";
    if (jsonFlag) {
      writeJsonError("NOT_INITIALIZED", msg, {});
    } else {
      writePlainError(`NOT_INITIALIZED: ${msg}`);
    }
    process.exit(1);
  }

  const tasks = findAllTasks(dir);
  const grouped = groupTasksByColumn(tasks);

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(grouped) + "\n");
  } else {
    process.stdout.write(renderBoard(grouped, { color: shouldColor() }));
  }
}

process.exit(0);
