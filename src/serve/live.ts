import { watch, type FSWatcher } from "node:fs";
import type { BoardSnapshot } from "./snapshot.ts";

/** Trailing debounce window: coalesce the event burst one commit produces. */
const WATCH_DEBOUNCE_MS = 75;

/**
 * Decide whether an `fs.watch` event on the Store root is internal write
 * coordination churn that must NOT trigger a board rebroadcast.
 *
 * `fs.watch` reports the path relative to the watched (Store root) dir with `/`
 * separators (verified by test on this Bun/macOS version). We drop:
 *   - git commit internals: the bare `.git` dir event and anything under
 *     `.git/` (one commit churns many objects/refs).
 *   - the flock file `.tasks-lock`, touched at the START of every mutation
 *     BEFORE the `git mv`/commit. Without this filter its early event would
 *     settle the debounce and broadcast the PRE-mutation (stale) snapshot.
 *   - null filenames (no actionable path).
 *
 * Exported for direct unit testing of the filter without spinning a server.
 */
export function isIgnoredWatchPath(filename: string | null): boolean {
  return (
    filename === null ||
    filename === ".git" ||
    filename.startsWith(".git/") ||
    filename === ".tasks-lock"
  );
}

/**
 * The live-sync engine behind `GET /api/events`. Owns a SINGLE shared
 * `fs.watch` on the Store root that feeds ALL connected SSE clients, plus the
 * trailing debounce and the set of client controllers. Everything is hidden
 * behind one method, `handleEvents()`, which returns the SSE `Response`.
 *
 * Lifecycle: the watcher is lazily started on the first client and torn down
 * when the last leaves, so a server with no live viewers holds no FSEvents
 * handle. On each non-ignored, debounced event the engine builds the snapshot
 * ONCE (via the injected `readSnapshot`, the same assembly `GET /api/board`
 * uses, so frames are byte-identical) and writes it to every client. The
 * snapshot is full + authoritative, so a coalesced or dropped event still
 * converges every client on the next tick — no per-event diffing.
 */
export function createLiveSync(
  dir: string,
  readSnapshot: (dir: string) => BoardSnapshot,
): { handleEvents: () => Response } {
  const clients = new Set<ReadableStreamDefaultController>();
  const encoder = new TextEncoder();
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  function frameFor(snapshot: BoardSnapshot): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  function broadcast(): void {
    let snapshot: BoardSnapshot;
    try {
      snapshot = readSnapshot(dir);
    } catch {
      // A transient read mid-commit shouldn't kill the stream; the next tick
      // (or the next mutation) re-reads and converges.
      return;
    }
    const frame = frameFor(snapshot);
    for (const controller of clients) {
      try {
        controller.enqueue(frame);
      } catch {
        // Controller already closed (client disconnected between cancel and
        // this tick): drop it so we never throw writing to a dead stream.
        clients.delete(controller);
      }
    }
  }

  function onFsEvent(_event: string, filename: string | null): void {
    if (isIgnoredWatchPath(filename)) return;
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      broadcast();
    }, WATCH_DEBOUNCE_MS);
  }

  function ensureWatcher(): void {
    if (watcher !== null) return;
    watcher = watch(dir, { recursive: true }, onFsEvent);
  }

  function teardownWatcher(): void {
    if (debounce !== null) {
      clearTimeout(debounce);
      debounce = null;
    }
    if (watcher !== null) {
      watcher.close();
      watcher = null;
    }
  }

  function handleEvents(): Response {
    let self: ReadableStreamDefaultController;
    const stream = new ReadableStream({
      start(controller) {
        self = controller;
        clients.add(controller);
        ensureWatcher();
        // Initial snapshot on connect so a fresh client renders immediately,
        // without waiting for the next mutation (documented contract).
        try {
          controller.enqueue(frameFor(readSnapshot(dir)));
        } catch {
          /* board unreadable at connect; the next tick will deliver it */
        }
      },
      cancel() {
        clients.delete(self);
        if (clients.size === 0) teardownWatcher();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  return { handleEvents };
}
