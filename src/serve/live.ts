import { watch, type FSWatcher } from "node:fs";
import type { BoardSnapshot } from "./snapshot.ts";

/** Trailing debounce window: coalesce the event burst one commit produces. */
const WATCH_DEBOUNCE_MS = 75;

/** Default keep-alive cadence. A `:`-comment on this interval keeps an idle SSE
 *  connection warm so a buffering intermediary (the dev Vite proxy, a reverse
 *  proxy) can't silently stall it: no frame for minutes reads as a dead pipe to
 *  some proxies, which then drop it with no `error` the client can react to. */
const HEARTBEAT_MS = 15000;

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
  heartbeatMs: number = HEARTBEAT_MS,
): { handleEvents: () => Response } {
  const clients = new Set<ReadableStreamDefaultController>();
  const encoder = new TextEncoder();
  const heartbeatFrame = encoder.encode(`: keep-alive\n\n`);
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function frameFor(snapshot: BoardSnapshot): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  /** Write one frame to every client, dropping any whose controller is already
   *  closed (a client that disconnected between its cancel() and this write).
   *  The single home for the dead-client guard: both the snapshot broadcast and
   *  the heartbeat keep-alive go through here. */
  function enqueueAll(frame: Uint8Array): void {
    for (const controller of clients) {
      try {
        controller.enqueue(frame);
      } catch {
        clients.delete(controller);
      }
    }
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
    enqueueAll(frameFor(snapshot));
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
    // Heartbeat shares the watcher's lifecycle: lazily started on the first
    // client, torn down with the watcher when the last one leaves. A
    // heartbeatMs <= 0 disables it (lets a test opt out entirely). The frame is
    // a `:`-prefixed SSE comment: EventSource ignores it (no `message` event),
    // but the bytes on the wire keep the connection from going idle long enough
    // for an intermediary to drop it.
    if (heartbeatMs > 0 && heartbeat === null) {
      heartbeat = setInterval(() => enqueueAll(heartbeatFrame), heartbeatMs);
    }
  }

  function teardownWatcher(): void {
    if (debounce !== null) {
      clearTimeout(debounce);
      debounce = null;
    }
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
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
