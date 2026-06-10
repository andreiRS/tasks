// Board snapshot store (Zustand). Holds the latest `/api/board` snapshot plus
// the optimistic-write overlay introduced in #19 (drag-to-move).
//
// Write model (see docs/specs/serve-board-write-interaction.md):
//   - move() applies the lane change optimistically, fires POST /api/tasks/:id/move,
//     then refetches /api/board and reconciles through applySnapshot().
//   - A pending write is tracked per task uuid; its 200ms delay timer flips the
//     card to the "saving…" look only if the write is genuinely slow.
//   - applySnapshot() is the single reconcile path. #20 (SSE) will call this same
//     action from an EventSource with no rework.
//   - A failed move snaps the card back and raises a toast carrying the code.

import { create } from "zustand";
import type { Board, BoardTask } from "./board/types";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** One in-flight optimistic move, keyed by task uuid in the store map. */
export interface PendingMove {
  uuid: string;
  fromColumn: string;
  toColumn: string;
  /** Becomes true once the 200ms delay timer fires (drives the pending look). */
  showPending: boolean;
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

  /** Fetch the current snapshot from the API and replace store state. */
  load: () => Promise<void>;
  /** Replace the board wholesale and re-overlay still-pending writes. The one
   *  reconcile path; #20 calls this from SSE too. Idempotent. */
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

  applySnapshot: (board) => {
    // Re-overlay only the writes still in flight; clear any whose effect the
    // snapshot already reflects (idempotent reconcile).
    const { pending } = get();
    const nextPending: Record<string, PendingMove> = {};
    for (const p of Object.values(pending)) {
      const lane = board.lanes[p.toColumn] ?? [];
      const landed = lane.some((t) => t.uuid === p.uuid);
      if (landed) {
        // Snapshot agrees — pending resolved.
        clearDelayTimer(p.uuid);
      } else {
        nextPending[p.uuid] = p;
      }
    }
    set({ board, pending: nextPending, status: "ready", error: null });
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

    // 1. Optimistic apply.
    set({ board: applyOptimisticMove(board, task, toColumn) });

    // 2. Track the pending write + start the 200ms delay-gate timer.
    set((s) => ({
      pending: {
        ...s.pending,
        [task.uuid]: { uuid: task.uuid, fromColumn, toColumn, showPending: false },
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

    // 3. Persist, then reconcile against an authoritative refetch.
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

      // Success — refetch the full board and reconcile (same path #20 uses).
      const snapRes = await fetch("/api/board");
      if (!snapRes.ok) throw new Error(`HTTP ${snapRes.status}`);
      const snapshot = (await snapRes.json()) as Board;
      get().applySnapshot(snapshot);
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
