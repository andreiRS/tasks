import { ensureStore, findFlockOrFail, isStoreDirty, storeDir, TasksError } from "../store.ts";
import { writeJsonError } from "./errors.ts";

/**
 * Verify `flock(1)` is available on PATH. On failure, emit the error using the
 * raw stderr format (the TasksError message is already user-ready) and exit.
 */
export function flockGuard(jsonFlag: boolean): void {
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
}

/**
 * Refuse to proceed if the store has uncommitted changes. Emits STORE_DIRTY
 * with the standard message and exits on failure.
 *
 * This is a fast, clear early check outside the lock; the definitive guard
 * lives inside each store mutation's withLock.
 */
export async function ensureCleanStore(dir: string, jsonFlag: boolean): Promise<void> {
  if (await isStoreDirty(dir)) {
    const msg = "store working tree is dirty; commit or discard pending changes before running mutating commands";
    if (jsonFlag) {
      writeJsonError("STORE_DIRTY", msg, {});
    } else {
      process.stderr.write(`tasks: STORE_DIRTY: ${msg}\n`);
    }
    process.exit(1);
  }
}

/**
 * Run the standard preamble for mutating commands:
 *   flockGuard → storeDir(cwd) → ensureStore → ensureCleanStore
 *
 * Returns the store directory path. Commands that need a different shape
 * (e.g. `edit` skips the dirty check, `init` skips ensureStore, `next` is
 * read-only) should call the lower-level helpers directly.
 */
export async function mutatingPreamble(jsonFlag: boolean): Promise<string> {
  flockGuard(jsonFlag);
  const dir = storeDir(process.cwd());
  await ensureStore(dir);
  await ensureCleanStore(dir, jsonFlag);
  return dir;
}
