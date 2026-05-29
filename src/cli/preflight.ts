import { ensureStore, findFlockOrFail, isStoreDirty, storeDir } from "../store.ts";
import { emit, failFromError, type OutputContext } from "./output.ts";

/**
 * Verify `flock(1)` is available on PATH. On failure, emit the error using the
 * raw stderr format (the TasksError message is already user-ready) and exit.
 */
export function flockGuard(ctx: OutputContext): void {
  try {
    findFlockOrFail();
  } catch (err) {
    emit(failFromError(err, "raw"), ctx);
  }
}

/**
 * Refuse to proceed if the store has uncommitted changes. Emits STORE_DIRTY
 * with the standard message and exits on failure.
 *
 * This is a fast, clear early check outside the lock; the definitive guard
 * lives inside each store mutation's withLock.
 */
export async function ensureCleanStore(dir: string, ctx: OutputContext): Promise<void> {
  if (await isStoreDirty(dir)) {
    const msg = "store working tree is dirty; commit or discard pending changes before running mutating commands";
    emit({ ok: false, code: "STORE_DIRTY", message: msg }, ctx);
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
export async function mutatingPreamble(ctx: OutputContext): Promise<string> {
  flockGuard(ctx);
  const dir = storeDir(process.cwd());
  await ensureStore(dir);
  await ensureCleanStore(dir, ctx);
  return dir;
}
