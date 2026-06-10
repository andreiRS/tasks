// Board snapshot store (Zustand). Holds the latest board snapshot plus the
// optimistic-write overlay introduced in #19 (drag-to-move).
//
// Write model (see docs/specs/serve-board-write-interaction.md):
//   - move() applies the lane change optimistically, fires POST /api/tasks/:id/move,
//     then lets the SSE broadcast frame reconcile through applySnapshot(). There
//     is no success-path refetch (#20): the commit's snapshot clears the pending
//     write, and a manual refetch would only risk clobbering a newer frame.
//   - A pending write is tracked per task uuid; its 200ms delay timer flips the
//     card to the "saving…" look only if the write is genuinely slow. It also
//     records the board head it was issued against, so reconciliation can tell a
//     snapshot that post-dates the write from one that pre-dates it.
//   - applySnapshot() is the single reconcile path; subscribe() (the SSE
//     EventSource) and the load()/move() fallbacks all funnel through it. It is
//     idempotent and ignores a snapshot strictly older than the one applied.
//   - A failed move snaps the card back and raises a toast carrying the code.

import { create } from "zustand";
import type { Board, BoardHead, BoardTask } from "./board/types";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** One in-flight optimistic move, keyed by task uuid in the store map. */
export interface PendingMove {
  uuid: string;
  fromColumn: string;
  toColumn: string;
  /** Becomes true once the 200ms delay timer fires (drives the pending look). */
  showPending: boolean;
  /** Board head the move was issued against (the snapshot the optimistic apply
   *  sat on top of), or null if the board had no head yet. Reconciliation uses
   *  it to decide whether an incoming snapshot post-dates this write: only a
   *  snapshot newer than this head can confirm or supersede it. */
  issuedHead: BoardHead | null;
}

/** Minimal toast slice for #19. #23 generalizes the write-failure UX. */
export interface Toast {
  code: string;
  message: string;
}

interface BoardState {
  board: Board | null;
  status: LoadStatus;
  error: string | null;
  /** Pending moves keyed by task uuid. */
  pending: Record<string, PendingMove>;
  toast: Toast | null;
  /** Head of the most recently applied snapshot. Drives the stale-snapshot
   *  ordering guard: a frame strictly older than this is ignored. */
  appliedHead: BoardHead | null;

  /** Fetch the current snapshot from the API and replace store state. A
   *  fallback for when the SSE stream can't connect; the live subscription is
   *  the primary path that keeps the board current. */
  load: () => Promise<void>;
  /** Open the SSE stream and reconcile every frame through applySnapshot().
   *  Returns a cleanup that closes the EventSource. Safe under StrictMode's
   *  double-invoke: the effect's cleanup closes the connection before re-open. */
  subscribe: () => () => void;
  /** Replace the board wholesale and re-overlay still-pending writes. The one
   *  reconcile path; SSE, load(), and move()'s fallback all funnel here.
   *  Idempotent, and ignores a snapshot strictly older than the applied one. */
  applySnapshot: (board: Board) => void;
  /** Optimistically move a task to `toColumn`, persist, then reconcile. */
  move: (task: BoardTask, toColumn: string) => Promise<void>;
  dismissToast: () => void;
}

/** 200ms timers, kept outside React/store state so re-renders never touch them. */
const delayTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PENDING_DELAY_MS = 200;

function clearDelayTimer(uuid: string): void {
  const t = delayTimers.get(uuid);
  if (t !== undefined) {
    clearTimeout(t);
    delayTimers.delete(uuid);
  }
}

/**
 * Order two board heads along the Store's linear commit history.
 *
 * `committed_at` is the commit time (`git log --format=%cI`, ISO-8601), which is
 * non-decreasing along a linear history, so lexicographic string compare of the
 * ISO timestamps orders them. Returns <0 if `a` is older than `b`, >0 if newer,
 * 0 if equal-or-indistinguishable. A `null` head (empty store) sorts oldest.
 * When timestamps tie but the shas differ, we treat them as equal in time
 * (idempotent re-apply path) — the linear-history invariant means a true newer
 * commit carries a `committed_at` that is not strictly older.
 */
function compareHeads(a: BoardHead | null, b: BoardHead | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (a.committed_at < b.committed_at) return -1;
  if (a.committed_at > b.committed_at) return 1;
  return 0;
}

/** Move a task to the end of `toColumn` in a fresh lanes map (optimistic apply).
 *  The reconciling snapshot fixes final oldest-first order. */
function applyOptimisticMove(board: Board, task: BoardTask, toColumn: string): Board {
  const lanes: Record<string, BoardTask[]> = {};
  for (const col of board.columns) {
    lanes[col] = (board.lanes[col] ?? []).filter((t) => t.uuid !== task.uuid);
  }
  const moved: BoardTask = { ...task, column: toColumn };
  lanes[toColumn] = [...(lanes[toColumn] ?? []), moved];
  return { ...board, lanes };
}

/** Relocate the card already present in `board` (found by uuid) to the end of
 *  `toCol`. Uses the card object the current board holds — never a stale
 *  drag-time copy — so snap-back can't re-materialize outdated fields. Returns
 *  the board unchanged if the uuid isn't present anywhere. */
function moveCardBetweenLanes(board: Board, uuid: string, toCol: string): Board {
  let card: BoardTask | undefined;
  for (const col of board.columns) {
    const found = (board.lanes[col] ?? []).find((t) => t.uuid === uuid);
    if (found) {
      card = found;
      break;
    }
  }
  if (!card) return board;
  const lanes: Record<string, BoardTask[]> = {};
  for (const col of board.columns) {
    lanes[col] = (board.lanes[col] ?? []).filter((t) => t.uuid !== uuid);
  }
  lanes[toCol] = [...(lanes[toCol] ?? []), { ...card, column: toCol }];
  return { ...board, lanes };
}

export const useBoardStore = create<BoardState>((set, get) => ({
  board: null,
  status: "idle",
  error: null,
  pending: {},
  toast: null,
  appliedHead: null,

  load: async () => {
    set({ status: "loading", error: null });
    try {
      const res = await fetch("/api/board");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const board = (await res.json()) as Board;
      get().applySnapshot(board);
    } catch (err) {
      set({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },

  subscribe: () => {
    // Lazily connect; the server pushes a full snapshot on connect, so the
    // first frame renders the board (replacing the mount-time load() as the
    // primary path). Each later frame is a full snapshot too.
    const source = new EventSource("/api/events");
    source.onmessage = (ev) => {
      let snapshot: Board;
      try {
        snapshot = JSON.parse(ev.data) as Board;
      } catch {
        return; // malformed frame: ignore, the next frame converges.
      }
      get().applySnapshot(snapshot);
    };
    // EventSource auto-reconnects on a dropped stream. We must NOT close() on a
    // transient error or we'd kill that native retry; just surface it if the
    // board never connected. The reconnect's connect-frame reconciles cleanly
    // because applySnapshot is idempotent and order-guarded.
    source.onerror = () => {
      if (get().status !== "ready") {
        set({ status: "error", error: "could not connect to /api/events" });
      }
    };
    return () => source.close();
  },

  applySnapshot: (board) => {
    // (5) Stale-snapshot ordering guard. Commit history is linear, so a frame
    // whose head is strictly older than the applied one is stale (a late load()
    // resolving after a newer SSE frame, or out-of-order delivery) — drop it.
    // Equal-or-newer re-applies idempotently.
    const { appliedHead } = get();
    if (compareHeads(board.head, appliedHead) < 0) return;

    // (6) Reconcile pending writes against THIS snapshot. A pending write is
    // resolved only by a snapshot that post-dates the write's commit (its head
    // strictly newer than the head the write was issued against); a snapshot
    // that pre-dates or is concurrent with the write keeps the overlay.
    const { pending } = get();
    const nextPending: Record<string, PendingMove> = {};
    let discardedOwnWrite = false;
    for (const p of Object.values(pending)) {
      const postDates = compareHeads(board.head, p.issuedHead) > 0;
      if (!postDates) {
        // Snapshot doesn't yet reflect a commit after this write — the write
        // may still be in flight/committing. Keep the optimistic overlay.
        nextPending[p.uuid] = p;
        continue;
      }
      const lane = board.lanes[p.toColumn] ?? [];
      const landed = lane.some((t) => t.uuid === p.uuid);
      clearDelayTimer(p.uuid);
      if (!landed) {
        // The write was superseded or never landed (a newer commit doesn't show
        // it in the target lane). The snapshot wins; per spec §5 toast because
        // the user's own change was discarded.
        discardedOwnWrite = true;
      }
      // Either way the pending overlay is dropped: a confirming snapshot already
      // places the card, a superseding one wins outright.
    }
    set((s) => ({
      board,
      pending: nextPending,
      status: "ready",
      error: null,
      appliedHead: board.head,
      toast: discardedOwnWrite
        ? { code: "SUPERSEDED", message: "your change was replaced by a newer update" }
        : s.toast,
    }));
  },

  move: async (task, toColumn) => {
    const board = get().board;
    if (!board) return;
    if (task.column === toColumn) return; // drop on own lane = no-op, no POST.
    // A card with an in-flight move can't be dragged again until it resolves:
    // a second move would overwrite pending (with a now-wrong fromColumn) and
    // orphan the first request. Ignore the drag until the pending write lands.
    if (get().pending[task.uuid]) return;

    const fromColumn = task.column;
    // Head the write is issued against: reconciliation only lets a snapshot that
    // post-dates this head confirm or supersede the move.
    const issuedHead = board.head;

    // 1. Optimistic apply.
    set({ board: applyOptimisticMove(board, task, toColumn) });

    // 2. Track the pending write + start the 200ms delay-gate timer.
    set((s) => ({
      pending: {
        ...s.pending,
        [task.uuid]: { uuid: task.uuid, fromColumn, toColumn, showPending: false, issuedHead },
      },
    }));
    clearDelayTimer(task.uuid);
    delayTimers.set(
      task.uuid,
      setTimeout(() => {
        delayTimers.delete(task.uuid);
        set((s) => {
          const p = s.pending[task.uuid];
          if (!p) return s; // already confirmed/failed
          return { pending: { ...s.pending, [task.uuid]: { ...p, showPending: true } } };
        });
      }, PENDING_DELAY_MS),
    );

    // 3. Persist. On success we do NOT refetch: the commit's SSE broadcast frame
    //    post-dates this write and reconciles it via applySnapshot (clearing the
    //    pending overlay). A manual refetch here would be redundant and could
    //    clobber a newer frame, so it's gone (#20 item 4).
    try {
      const res = await fetch(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: toColumn }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        const code = body?.error?.code ?? `HTTP_${res.status}`;
        const message = body?.error?.message ?? `move failed (${res.status})`;
        throw new MoveError(code, message);
      }
      // Success: leave the pending overlay in place; the SSE frame clears it.
    } catch (err) {
      // 4. Failure — snap the card back to its source lane, clear pending, toast.
      clearDelayTimer(task.uuid);
      const code = err instanceof MoveError ? err.code : "TRANSPORT_ERROR";
      const message = err instanceof Error ? err.message : String(err);
      set((s) => {
        const { [task.uuid]: _dropped, ...rest } = s.pending;
        const current = s.board;
        // Snap back ONLY when the card is still our optimistic copy in toColumn.
        // If a newer authoritative snapshot superseded the move (card no longer
        // in toColumn), the snapshot already won — leave the board untouched.
        // When we do snap back, relocate the card the current board holds, never
        // the stale drag-time object.
        const stillOptimistic =
          current?.lanes[toColumn]?.some((t) => t.uuid === task.uuid) ?? false;
        const snappedBack =
          current && stillOptimistic
            ? moveCardBetweenLanes(current, task.uuid, fromColumn)
            : current;
        return { board: snappedBack, pending: rest, toast: { code, message } };
      });
    }
  },

  dismissToast: () => set({ toast: null }),
}));

/** Carries the server error envelope's `code` to the catch handler. */
class MoveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MoveError";
  }
}
