#!/usr/bin/env bun
import { storeDir, ensureStore, createTask, resolveStoreDir, findTask, findFlockOrFail, TasksError } from "./store.ts";

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
  const id = await createTask(dir, title);
  process.stdout.write(`task: new #${id} — ${title}\n`);
} else if (command === "show") {
  // Determine whether --json was passed and get the id/uuid argument
  const jsonFlag = rest.includes("--json");
  const idOrUuid = rest.find((a) => a !== "--json") ?? "";

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
    // Human renderer is M2; for now just show a basic summary
    process.stdout.write(`#${task.id} ${task.title} [${task.column}]\n`);
  }
}

process.exit(0);
