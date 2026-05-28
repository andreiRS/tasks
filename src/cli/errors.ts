import { TasksError } from "../store.ts";

/**
 * Write a JSON error envelope to stderr.
 * Shape: { "error": { "code": string, "message": string, "details": object } }
 */
export function writeJsonError(code: string, message: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ error: { code, message, details } }) + "\n");
}

/**
 * Write a plain-text error to stderr, prefixed with `tasks:`.
 */
export function writePlainError(message: string): void {
  process.stderr.write(`tasks: ${message}\n`);
}

/**
 * Handle a thrown TasksError consistently across commands.
 *
 * `plainFormat`:
 *   - "prefixed" (default): writes `tasks: CODE: message` via writePlainError
 *   - "raw": writes the error's `.message` directly (used after flock checks
 *     where the raw message already contains a usable prefix)
 *
 * Re-throws non-TasksError exceptions. Calls process.exit(1) on TasksError.
 */
export function handleTasksError(
  err: unknown,
  jsonFlag: boolean,
  plainFormat: "prefixed" | "raw" = "prefixed"
): never | void {
  if (err instanceof TasksError) {
    if (jsonFlag) {
      writeJsonError(err.code, err.message, err.details);
    } else if (plainFormat === "raw") {
      process.stderr.write(`${err.message}\n`);
    } else {
      writePlainError(`${err.code}: ${err.message}`);
    }
    process.exit(1);
  }
  throw err;
}
