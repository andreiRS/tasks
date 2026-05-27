#!/usr/bin/env bun
import { storeDir, ensureStore, createTask } from "./store.ts";

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
  const title = rest[0] ?? "";
  const titleError = validateTitle(title);
  if (titleError !== null) {
    process.stderr.write(`tasks: INVALID_TITLE: ${titleError}\n`);
    process.exit(1);
  }

  const dir = storeDir(process.cwd());
  await ensureStore(dir);
  const id = await createTask(dir, title);
  process.stdout.write(`task: new #${id} — ${title}\n`);
}

process.exit(0);
