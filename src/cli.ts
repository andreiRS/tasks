#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { storeDir, ensureStore, createTask, isStoreDirty, resolveStoreDir, findTask, findAllTasks, groupTasksByColumn, findFlockOrFail, moveTask, removeTask, editTask, abortPendingEdits, TasksError, COLUMNS } from "./store.ts";
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

/**
 * Parse a duration string of the form `<N>d` (e.g. "7d", "30d", "0d").
 * Returns the number of days as a non-negative integer, or null if the
 * input does not match the expected format or is negative.
 *
 * Valid: "7d", "0d", "30d"
 * Invalid: "abc", "-1d", "7", "7 d"
 */
function parseSinceDays(value: string): number | null {
  const match = /^(\d+)d$/.exec(value);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Apply the done-column cutoff filter to a task list.
 *
 * @param tasks     Full task array.
 * @param allFlag   When true, skip all cutoff filtering.
 * @param sinceDays Number of days; tasks in `done` whose `updated_at` is
 *                  strictly older than `sinceDays` days ago are removed.
 *                  Default is 7 days.
 */
function applyDoneCutoff(
  tasks: import("./store.ts").TaskData[],
  allFlag: boolean,
  sinceDays: number
): import("./store.ts").TaskData[] {
  if (allFlag) return tasks;
  const cutoffMs = sinceDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  return tasks.filter((t) => {
    if (t.column !== "done") return true;
    const updatedMs = new Date(t.updated_at).getTime();
    return now - updatedMs <= cutoffMs;
  });
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

  const allFlag = rest.includes("--all");

  // Parse --since <duration> (e.g. --since 30d)
  let sinceDays = 7; // default: 7-day cutoff
  const sinceIdx = rest.indexOf("--since");
  if (sinceIdx !== -1 && sinceIdx + 1 < rest.length) {
    const sinceVal = rest[sinceIdx + 1];
    const parsed = parseSinceDays(sinceVal);
    if (parsed === null) {
      const msg = `invalid --since value: ${sinceVal}. Expected format: <N>d (e.g. 7d, 30d)`;
      if (jsonFlag) {
        writeJsonError("INVALID_SINCE", msg, { value: sinceVal });
      } else {
        writePlainError(`INVALID_SINCE: ${msg}`);
      }
      process.exit(1);
    }
    sinceDays = parsed;
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

  // Apply done-column cutoff before any other filters.
  tasks = applyDoneCutoff(tasks, allFlag, sinceDays);

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
  const allFlag = rest.includes("--all");

  function shouldColor(): boolean {
    if (noColorFlag) return false;
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
    if (process.env.FORCE_COLOR === "1") return true;
    return Boolean(process.stdout.isTTY);
  }

  // Parse --since <duration> (e.g. --since 30d)
  let sinceDays = 7; // default: 7-day cutoff
  const sinceIdx = rest.indexOf("--since");
  if (sinceIdx !== -1 && sinceIdx + 1 < rest.length) {
    const sinceVal = rest[sinceIdx + 1];
    const parsed = parseSinceDays(sinceVal);
    if (parsed === null) {
      const msg = `invalid --since value: ${sinceVal}. Expected format: <N>d (e.g. 7d, 30d)`;
      if (jsonFlag) {
        writeJsonError("INVALID_SINCE", msg, { value: sinceVal });
      } else {
        writePlainError(`INVALID_SINCE: ${msg}`);
      }
      process.exit(1);
    }
    sinceDays = parsed;
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

  // Apply done-column cutoff.
  tasks = applyDoneCutoff(tasks, allFlag, sinceDays);

  const grouped = groupTasksByColumn(tasks);

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(grouped) + "\n");
  } else {
    process.stdout.write(renderBoard(grouped, { color: shouldColor() }));
  }
} else if (command === "mv") {
  const jsonFlag = rest.includes("--json");
  const posArgs = rest.filter((a) => a !== "--json");
  const [idOrUuid, targetColumn] = posArgs;

  if (!idOrUuid || !targetColumn) {
    const msg = "usage: tasks mv <id|uuid> <column>";
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", msg, {});
    } else {
      writePlainError(`MISSING_FIELD: ${msg}`);
    }
    process.exit(1);
  }

  // Validate column up front before touching the store
  if (!COLUMNS.includes(targetColumn)) {
    const msg = `unknown column: ${targetColumn}. Valid columns: ${COLUMNS.join(", ")}`;
    if (jsonFlag) {
      writeJsonError("INVALID_COLUMN", msg, { column: targetColumn, valid: COLUMNS });
    } else {
      writePlainError(`INVALID_COLUMN: ${msg}`);
    }
    process.exit(1);
  }

  // Check flock availability
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

  // Early dirty-tree check (outside lock) for a fast, clear error message
  if (await isStoreDirty(dir)) {
    const msg = "store working tree is dirty; commit or discard pending changes before running mutating commands";
    if (jsonFlag) {
      writeJsonError("STORE_DIRTY", msg, {});
    } else {
      process.stderr.write(`tasks: STORE_DIRTY: ${msg}\n`);
    }
    process.exit(1);
  }

  try {
    await moveTask(dir, idOrUuid, targetColumn);
  } catch (err) {
    if (err instanceof TasksError) {
      if (jsonFlag) {
        writeJsonError(err.code, err.message, err.details);
      } else {
        writePlainError(`${err.code}: ${err.message}`);
      }
      process.exit(1);
    }
    throw err;
  }
} else if (command === "rm") {
  const jsonFlag = rest.includes("--json");
  const idOrUuid = rest.find((a) => a !== "--json") ?? "";

  if (!idOrUuid) {
    const msg = "usage: tasks rm <id|uuid>";
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", msg, {});
    } else {
      writePlainError(`MISSING_FIELD: ${msg}`);
    }
    process.exit(1);
  }

  // Check flock availability
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

  // Early dirty-tree check (outside lock) for a fast, clear error message
  if (await isStoreDirty(dir)) {
    const msg = "store working tree is dirty; commit or discard pending changes before running mutating commands";
    if (jsonFlag) {
      writeJsonError("STORE_DIRTY", msg, {});
    } else {
      process.stderr.write(`tasks: STORE_DIRTY: ${msg}\n`);
    }
    process.exit(1);
  }

  try {
    await removeTask(dir, idOrUuid);
  } catch (err) {
    if (err instanceof TasksError) {
      if (jsonFlag) {
        writeJsonError(err.code, err.message, err.details);
      } else {
        writePlainError(`${err.code}: ${err.message}`);
      }
      process.exit(1);
    }
    throw err;
  }
} else if (command === "edit") {
  const jsonFlag = rest.includes("--json");
  const abortFlag = rest.includes("--abort");
  const idOrUuid = rest.find((a) => a !== "--json" && a !== "--abort") ?? "";

  // Check flock availability first.
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

  // `--abort` short-circuits everything: no editor, no id required.
  if (abortFlag) {
    await abortPendingEdits(dir);
    process.exit(0);
  }

  if (!idOrUuid) {
    const msg = "usage: tasks edit <id|uuid> [--abort]";
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", msg, {});
    } else {
      writePlainError(`MISSING_FIELD: ${msg}`);
    }
    process.exit(1);
  }

  const editorEnv = process.env.EDITOR ?? process.env.VISUAL;
  if (!editorEnv || editorEnv.trim() === "") {
    const msg = "$EDITOR is not set; set EDITOR to your editor (e.g. vim, nano) and retry";
    if (jsonFlag) {
      writeJsonError("NO_EDITOR", msg, {});
    } else {
      writePlainError(`NO_EDITOR: ${msg}`);
    }
    process.exit(1);
  }

  // Edit is EXEMPT from STORE_DIRTY by PRD design.
  try {
    await editTask(dir, idOrUuid, async (filePath: string) => {
      // Spawn `$EDITOR <file>` through the shell so values like
      // `cp /path/to/x` (or `true`/`false`) work naturally.
      const proc = Bun.spawn(["sh", "-c", `${editorEnv} "$1"`, "sh", filePath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return await proc.exited;
    });
  } catch (err) {
    if (err instanceof TasksError) {
      if (jsonFlag) {
        writeJsonError(err.code, err.message, err.details);
      } else {
        writePlainError(`${err.code}: ${err.message}`);
      }
      process.exit(1);
    }
    throw err;
  }
}

process.exit(0);
