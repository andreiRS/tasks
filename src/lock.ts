import { existsSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { TasksError } from "./errors.ts";
import { validateEnums } from "./validation.ts";

/** Canonical message for the dirty-tree guard, shared by every mutation. */
const STORE_DIRTY_MESSAGE =
  "store working tree is dirty; commit or discard pending changes before running mutating commands";

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

/** Pre-flight guards a mutation runs inside the lock before touching the store. */
interface TransactionGuards {
  /** Reject if the working tree has uncommitted changes (STORE_DIRTY). */
  requireClean?: boolean;
  /** Reject if any existing task file carries an invalid enum value. */
  requireValidEnums?: boolean;
}

/**
 * Run a mutation under the store lock with the shared pre-flight guards.
 *
 * Every mutating command serializes on the flock, then (per `guards`) checks
 * the dirty-tree invariant and enum validity before `fn` writes anything.
 * Centralizing this preamble keeps the STORE_DIRTY message and guard ordering
 * identical across mutations and makes the invariants impossible to forget when
 * adding a new mutation.
 */
export async function withTransaction<T>(
  dir: string,
  guards: TransactionGuards,
  fn: () => Promise<T>,
): Promise<T> {
  return withLock(dir, async () => {
    if (guards.requireClean && (await isStoreDirty(dir))) {
      throw new TasksError("STORE_DIRTY", STORE_DIRTY_MESSAGE, {});
    }
    if (guards.requireValidEnums) {
      validateEnums(dir);
    }
    return fn();
  });
}
