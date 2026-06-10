// Board snapshot store (Zustand). Holds the latest board snapshot plus the
// optimistic-write overlay introduced in #19 (drag-to-move), extended by the
// create modal (#21) and the card-drawer edit (#22).
//
// Write model (see docs/specs/serve-board-write-interaction.md):
//   - move() applies the lane change optimistically, fires POST /api/tasks/:id/move,
//     then lets the SSE broadcast frame reconcile through applySnapshot(). There
//     is no success-path refetch (#20): the commit's snapshot clears the pending
//     write, and a manual refetch would only risk clobbering a newer frame.
//   - createTask() and editTask() follow the same shape: optimistic apply, fire
//     the POST/PATCH (edit sends only the changed fields), reconcile from the
//     next snapshot, snap back on failure. Selection state (selectedUuid +
//     openCard/closeCard) drives the drawer the edit is dispatched from.
//   - A pending write is tracked per task uuid; its 200ms delay timer flips the
//     card to the "saving…" look only if the write is genuinely slow. It also
//     records the board head it was issued against, so reconciliation can tell a
//     snapshot that post-dates the write from one that pre-dates it.
//   - applySnapshot() is the single reconcile path; subscribe() (the SSE
//     EventSource) and the load()/move() fallbacks all funnel through it. It is
//     idempotent and ignores a snapshot strictly older than the one applied.
//   - A failed move snaps the card back and raises a toast carrying the code.

import { create } from "zustand";
import type { Attendance, Board, BoardHead, BoardTask, Effort } from "./board/types";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Liveness of the SSE stream, independent of `status`. "live" once a frame is
 *  flowing; "reconnecting" while the stream is down AFTER the board already
 *  rendered (drives the subtle reconnecting hint, never the hard error screen). */
export type ConnectionState = "live" | "reconnecting";

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

/** One in-flight optimistic create, keyed by a temporary client key in the
 *  store map. Mirrors PendingMove's design: it carries the optimistic fields so
 *  the placeholder card can render, the head it was issued against (so a
 *  post-dating snapshot can reconcile it), the 200ms delay flag, and — once the
 *  POST returns 201 — the server-assigned uuid used to match the snapshot. */
export interface PendingCreate {
  /** Temporary client key (also the placeholder card's synthetic uuid). */
  tempKey: string;
  title: string;
  body: string;
  effort: Effort;
  /** Becomes true once the 200ms delay timer fires (drives the pending look). */
  showPending: boolean;
  /** Head the create was issued against; a snapshot post-dating it reconciles. */
  issuedHead: BoardHead | null;
  /** Server-assigned uuid, recorded after the POST returns 201. Until then the
   *  placeholder can't be matched in a snapshot (it has no real uuid yet). */
  uuid: string | null;
}

/** The editable subset of a Task's fields (drawer edit; #22). Column is moved
 *  via the move endpoint and deps stay CLI-only, so neither is editable here. */
export interface EditableFields {
  title?: string;
  body?: string;
  effort?: Effort;
  attendance?: Attendance;
}

/** One in-flight optimistic edit, keyed by task uuid in the store map. Mirrors
 *  PendingMove: it records the head the edit was issued against (so a snapshot
 *  post-dating it can confirm), the 200ms delay flag, and the PRE-edit field
 *  values used to snap the card back if the PATCH fails. */
export interface PendingEdit {
  uuid: string;
  /** The changed fields' NEW values (the optimistic apply). Re-overlaid onto a
   *  wholesale-replaced board while still pending, so they don't flash to old
   *  values before the confirming frame. */
  patch: EditableFields;
  /** The card's field values before the optimistic apply, for snap-back. */
  prevFields: EditableFields;
  /** Becomes true once the 200ms delay timer fires (drives the pending look). */
  showPending: boolean;
  /** Head the edit was issued against; a snapshot post-dating it reconciles. */
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
  /** Pending creates keyed by temporary client key. */
  pendingCreates: Record<string, PendingCreate>;
  /** Pending edits keyed by task uuid. */
  pendingEdits: Record<string, PendingEdit>;
  /** uuid of the card whose drawer is open, or null when closed (#22). The
   *  drawer reads the LIVE card from `board` by this uuid each render, so
   *  reconciled SSE updates flow through and a confirmed edit shows its values. */
  selectedUuid: string | null;
  toast: Toast | null;
  /** Head of the most recently applied snapshot. Drives the stale-snapshot
   *  ordering guard: a frame strictly older than this is ignored. */
  appliedHead: BoardHead | null;
  /** SSE liveness. Flips to "reconnecting" when an established stream drops
   *  (board still rendered) and back to "live" when a frame arrives again.
   *  An initial-connect failure does NOT use this — it shows the hard error
   *  screen via `status === "error"`. */
  connection: ConnectionState;

  /** Fetch the current snapshot from the API and replace store state. A
   *  fallback for when the SSE stream can't connect; the live subscription is
   *  the primary path that keeps the board current. */
  load: () => Promise<void>;
  /** Open the SSE stream and reconcile every frame through applySnapshot(),
   *  running its own self-healing reconnect loop (native auto-retry stalls in
   *  practice). Returns a cleanup that closes the live EventSource AND clears any
   *  pending reconnect timer. Safe under StrictMode's double-invoke: the cleanup
   *  tears everything down before the second setup runs. */
  subscribe: () => () => void;
  /** Replace the board wholesale and re-overlay still-pending writes. The one
   *  reconcile path; SSE, load(), and move()'s fallback all funnel here.
   *  Idempotent, and ignores a snapshot strictly older than the applied one. */
  applySnapshot: (board: Board) => void;
  /** Optimistically move a task to `toColumn`, persist, then reconcile. */
  move: (task: BoardTask, toColumn: string) => Promise<void>;
  /** Optimistically create a task in `backlog`, persist via POST /api/tasks,
   *  then let the SSE snapshot reconcile (drop the placeholder). */
  createTask: (input: { title: string; body: string; effort: Effort }) => Promise<void>;
  /** Optimistically edit a task's title/body/effort/attendance, PATCH the
   *  changed fields, then let the SSE snapshot reconcile (mirrors move/create). */
  editTask: (task: BoardTask, patch: EditableFields) => Promise<void>;
  /** Open the detail drawer for `uuid` (#22). */
  openCard: (uuid: string) => void;
  /** Close the detail drawer (#22). */
  closeCard: () => void;
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

/** Every task on a board, flattened across its lanes (canonical column order). */
function everyTask(b: Board): BoardTask[] {
  return b.columns.flatMap((c) => b.lanes[c] ?? []);
}

/** New tasks always land in `backlog`, attended (server contract). */
const BACKLOG = "backlog";

/** Build the optimistic placeholder card for a pending create. It carries the
 *  temp key as a synthetic uuid (so dnd/keys stay unique) and a sentinel id of
 *  -1 — Card renders a muted "#…" pill instead of a real short id for it. The
 *  reconciling snapshot replaces it with the real card (correct id + paper). */
function placeholderCard(p: PendingCreate): BoardTask {
  const now = new Date().toISOString();
  return {
    id: -1,
    uuid: p.tempKey,
    title: p.title,
    body: p.body,
    column: BACKLOG,
    effort: p.effort,
    attendance: "attended",
    updated_at: now,
    created_at: now,
    blockedBy: [],
  };
}

/** Append the placeholder for `p` to the end of `backlog` in a fresh lanes map.
 *  The reconciling snapshot fixes final oldest-first order. */
function applyOptimisticCreate(board: Board, p: PendingCreate): Board {
  const lanes: Record<string, BoardTask[]> = {};
  for (const col of board.columns) lanes[col] = board.lanes[col] ?? [];
  lanes[BACKLOG] = [...(lanes[BACKLOG] ?? []), placeholderCard(p)];
  return { ...board, lanes };
}

/** Apply `patch` to the card found by `uuid` in place (same lane, same order),
 *  in a fresh lanes map. Used for the optimistic edit and to re-overlay a still-
 *  pending edit's fields onto a wholesale-replaced board. Returns the board
 *  unchanged if the uuid isn't present. */
function applyOptimisticEdit(board: Board, uuid: string, patch: EditableFields): Board {
  const lanes: Record<string, BoardTask[]> = {};
  for (const col of board.columns) {
    lanes[col] = (board.lanes[col] ?? []).map((t) =>
      t.uuid === uuid ? { ...t, ...patch } : t,
    );
  }
  return { ...board, lanes };
}

export const useBoardStore = create<BoardState>((set, get) => ({
  board: null,
  status: "idle",
  error: null,
  pending: {},
  pendingCreates: {},
  pendingEdits: {},
  selectedUuid: null,
  toast: null,
  appliedHead: null,
  connection: "live",

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
    // Self-healing SSE loop. The browser's native EventSource auto-retry stalls
    // in practice (board goes silently stale on a bounced server), so we drive
    // reconnection ourselves: on any error we close the stalled source and open
    // a fresh one after a capped-backoff delay. State machine:
    //   connect → (message) live, hint cleared, backoff reset
    //           → (error)   close source, schedule one fresh connect after
    //                       `delay`, grow delay toward the cap; if the board was
    //                       already rendered show the subtle reconnecting hint,
    //                       otherwise show the hard error/retry screen.
    //   …a later message clears the hint and resets the delay.
    //
    // Single-connection / single-timer invariants:
    //   - `source` holds the one live EventSource; we close() it before opening
    //     another and null it out, so there is never more than one open stream.
    //   - `timer` holds the one pending reconnect timeout; scheduleReconnect is a
    //     no-op while a timer is already armed, so a burst of error events can't
    //     stack timers or cause a connection storm.
    //   - `closed` latches on cleanup so any in-flight error/timer callback that
    //     fires after unmount becomes inert.
    const RECONNECT_MIN_MS = 1000;
    const RECONNECT_MAX_MS = 8000;

    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = RECONNECT_MIN_MS;
    let closed = false;

    const connect = () => {
      if (closed) return;
      // The server pushes a full snapshot on connect, so the first frame renders
      // the board; each later frame is a full snapshot too.
      const es = new EventSource("/api/events");
      source = es;

      es.onmessage = (ev) => {
        if (closed) return;
        let snapshot: Board;
        try {
          snapshot = JSON.parse(ev.data) as Board;
        } catch {
          return; // malformed frame: ignore, the next frame converges.
        }
        // A frame proves the stream is live: clear any reconnecting hint and
        // reset the backoff so the next drop starts from the minimum delay.
        delay = RECONNECT_MIN_MS;
        if (get().connection !== "live") set({ connection: "live" });
        get().applySnapshot(snapshot);
      };

      es.onerror = () => {
        if (closed || source !== es) return; // stale handler from a closed source
        // Take over from the (stalling) native retry: drop this source and
        // schedule exactly one fresh connect.
        es.close();
        source = null;
        if (get().status === "ready") {
          // Established-then-dropped: keep the last board, show the subtle hint.
          if (get().connection !== "reconnecting") set({ connection: "reconnecting" });
        } else {
          // Never rendered: the initial connect failed — hard error/retry UI.
          set({ status: "error", error: "could not connect to /api/events" });
        }
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (closed || timer !== null) return; // single pending timer only
      const wait = delay;
      delay = Math.min(delay * 2, RECONNECT_MAX_MS); // mild capped backoff
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, wait);
    };

    connect();

    return () => {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (source !== null) {
        source.close();
        source = null;
      }
    };
  },

  applySnapshot: (board) => {
    // (5) Stale-snapshot ordering guard. Commit history is linear, so a frame
    // whose head is strictly older than the applied one is stale (a late load()
    // resolving after a newer SSE frame, or out-of-order delivery) — drop it.
    // Equal-or-newer re-applies idempotently.
    const { appliedHead } = get();
    if (compareHeads(board.head, appliedHead) < 0) return;

    // (6) Reconcile pending writes against THIS snapshot. A pending write is
    // resolved by any snapshot whose head is a different commit than the head
    // the write was issued against. We test post-dating by sha inequality, not
    // by committed_at: %cI is second-granularity, so a move that commits in the
    // same wall-clock second as its issuedHead has an EQUAL timestamp on a
    // distinct sha, and a strict-time compare would never clear it (stuck ◷
    // badge). The stale-snapshot guard above already dropped anything strictly
    // older than appliedHead, and history is linear, so any frame reaching here
    // with a head sha != issuedHead's sha is a genuine at-or-after commit.
    const { pending } = get();
    const nextPending: Record<string, PendingMove> = {};
    let discardedOwnWrite = false;
    for (const p of Object.values(pending)) {
      const postDates =
        board.head != null &&
        (p.issuedHead == null || board.head.sha !== p.issuedHead.sha);
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
    // (6b) Reconcile pending creates the same way. A create is resolved by any
    // snapshot whose head post-dates the head it was issued against AND that
    // contains the task by the uuid the POST returned. Match by uuid (sha-
    // inequality post-dating, like moves), not by the placeholder's synthetic
    // uuid: the placeholder lives only in the overlay. Until the POST returns a
    // uuid we can't match, so the placeholder simply stays. Once the real card
    // is in the snapshot we drop the placeholder — the snapshot card takes over.
    const { pendingCreates } = get();
    const nextPendingCreates: Record<string, PendingCreate> = {};
    for (const p of Object.values(pendingCreates)) {
      const postDates =
        board.head != null &&
        (p.issuedHead == null || board.head.sha !== p.issuedHead.sha);
      if (!postDates) {
        // Snapshot doesn't yet reflect a commit after this create — still in
        // flight/committing. Keep the optimistic placeholder.
        nextPendingCreates[p.tempKey] = p;
        continue;
      }
      const landed =
        p.uuid != null && everyTask(board).some((t) => t.uuid === p.uuid);
      if (!landed) {
        // Post-dating snapshot without our task: the POST hasn't recorded a uuid
        // yet (response in flight) — keep waiting — OR it landed by uuid we have
        // and just isn't here, which can't happen for an at-or-after commit of
        // our own successful create. The failure path (createTask catch) is what
        // drops a create that errored; here we only clear confirmed ones.
        nextPendingCreates[p.tempKey] = p;
        continue;
      }
      // Confirmed: the real card is in the snapshot. Drop the placeholder.
      clearDelayTimer(p.tempKey);
    }

    // (6c) Reconcile pending edits the same way. An edit is resolved by any
    // snapshot whose head is a different commit than the head the edit was
    // issued against (sha-inequality post-dating, like moves — committed_at is
    // second-granularity and a same-second commit ties on time but differs on
    // sha). A post-dating snapshot CONFIRMS the edit: its fields are
    // authoritative and already correct, so we just clear the timer and drop the
    // pending edit — never field-merge a confirmed edit, the snapshot wins
    // verbatim. While still pending (no post-dating frame yet) we keep the edit
    // so its optimistic fields can be re-overlaid below.
    const { pendingEdits } = get();
    const nextPendingEdits: Record<string, PendingEdit> = {};
    for (const p of Object.values(pendingEdits)) {
      const postDates =
        board.head != null &&
        (p.issuedHead == null || board.head.sha !== p.issuedHead.sha);
      if (!postDates) {
        // Snapshot doesn't yet reflect a commit after this edit — still in
        // flight/committing. Keep the optimistic overlay.
        nextPendingEdits[p.uuid] = p;
        continue;
      }
      // Confirmed by a post-dating commit. The snapshot's fields are truth.
      clearDelayTimer(p.uuid);
    }

    // Re-overlay still-pending create placeholders onto the replaced board.
    // Unlike a move (whose card already exists in the snapshot, just in another
    // lane), a create's card does NOT exist in any snapshot until its commit, so
    // a wholesale replace would make the placeholder vanish between the
    // optimistic apply and the confirming snapshot (e.g. an unrelated frame
    // arriving first). Re-appending keeps it visible; the confirming snapshot
    // drops it from pendingCreates and the real card takes its place.
    let nextBoard = board;
    for (const p of Object.values(nextPendingCreates)) {
      nextBoard = applyOptimisticCreate(nextBoard, p);
    }
    // Re-overlay still-pending edits' optimistic fields by uuid onto the
    // replaced board (exactly like pending creates above). The card already
    // exists in the snapshot, but a pre-dating frame (a different commit, e.g.
    // an unrelated mutation) would otherwise show its OLD field values until the
    // confirming commit lands. Confirmed edits aren't here — they were dropped
    // from nextPendingEdits above — so this never overrides an authoritative
    // snapshot value.
    for (const p of Object.values(nextPendingEdits)) {
      nextBoard = applyOptimisticEdit(nextBoard, p.uuid, p.patch);
    }

    // If the open drawer's card is gone from the (reconciled) board, close it —
    // a placeholder uuid still in pendingCreates keeps the drawer eligible.
    const selectedStillPresent =
      everyTask(nextBoard).some((t) => t.uuid === get().selectedUuid);

    set((s) => ({
      board: nextBoard,
      pending: nextPending,
      pendingCreates: nextPendingCreates,
      pendingEdits: nextPendingEdits,
      selectedUuid: s.selectedUuid != null && selectedStillPresent ? s.selectedUuid : null,
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
    // orphan the first request. An in-flight edit blocks too: moves and edits
    // share the uuid-keyed delayTimers slot, so starting a move mid-edit would
    // clobber the edit's timer/reconcile. Ignore the drag until both are clear.
    if (get().pending[task.uuid] || get().pendingEdits[task.uuid]) return;

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

  createTask: async ({ title, body, effort }) => {
    const board = get().board;
    if (!board) return; // no board yet; the modal is only reachable once ready.

    // Temp client key: doubles as the placeholder card's synthetic uuid and the
    // pendingCreates map key. Browser app code, so Date.now()/random are fine.
    const tempKey = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuedHead = board.head;
    const create: PendingCreate = {
      tempKey,
      title,
      body,
      effort,
      showPending: false,
      issuedHead,
      uuid: null,
    };

    // 1. Optimistic apply — placeholder appears in backlog immediately.
    set({ board: applyOptimisticCreate(board, create) });

    // 2. Track the pending create + start the 200ms delay-gate timer (a fast
    //    create confirms via SSE before this fires and never flashes pending).
    set((s) => ({ pendingCreates: { ...s.pendingCreates, [tempKey]: create } }));
    clearDelayTimer(tempKey);
    delayTimers.set(
      tempKey,
      setTimeout(() => {
        delayTimers.delete(tempKey);
        set((s) => {
          const p = s.pendingCreates[tempKey];
          if (!p) return s; // already confirmed/failed
          return {
            pendingCreates: { ...s.pendingCreates, [tempKey]: { ...p, showPending: true } },
          };
        });
      }, PENDING_DELAY_MS),
    );

    // 3. Persist. On 201 record the returned uuid against the temp key so
    //    applySnapshot can match the real card when a post-dating frame carries
    //    it. We do NOT refetch: the commit's SSE frame reconciles (drops the
    //    placeholder), same as move().
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body, effort }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        const code = errBody?.error?.code ?? `HTTP_${res.status}`;
        const message = errBody?.error?.message ?? `create failed (${res.status})`;
        throw new CreateError(code, message);
      }
      const ok = (await res.json().catch(() => null)) as { uuid?: string } | null;
      const uuid = ok?.uuid;
      // Record the uuid (if the placeholder is still pending — a very fast SSE
      // frame could already have... no: it can't confirm before we have the
      // uuid, so the placeholder is necessarily still here). Stash it so the
      // next post-dating snapshot reconciles by uuid.
      if (uuid) {
        set((s) => {
          const p = s.pendingCreates[tempKey];
          if (!p) return s;
          return { pendingCreates: { ...s.pendingCreates, [tempKey]: { ...p, uuid } } };
        });
        // The snapshot that committed this create may have ALREADY arrived while
        // the POST response was in flight (its head post-dates issuedHead but we
        // couldn't match it without the uuid, so it was kept). Re-run reconcile
        // against the current board now that we know the uuid.
        const current = get().board;
        if (current) get().applySnapshot(current);
      }
    } catch (err) {
      // 4. Failure — remove the placeholder, clear pending, toast the code.
      clearDelayTimer(tempKey);
      const code = err instanceof CreateError ? err.code : "TRANSPORT_ERROR";
      const message = err instanceof Error ? err.message : String(err);
      set((s) => {
        const { [tempKey]: _dropped, ...rest } = s.pendingCreates;
        const current = s.board;
        const cleaned = current
          ? {
              ...current,
              lanes: Object.fromEntries(
                current.columns.map((c) => [
                  c,
                  (current.lanes[c] ?? []).filter((t) => t.uuid !== tempKey),
                ]),
              ),
            }
          : current;
        return { board: cleaned, pendingCreates: rest, toast: { code, message } };
      });
    }
  },

  editTask: async (task, patch) => {
    const board = get().board;
    if (!board) return;

    // 1. Build the patch from CHANGED fields only (compare against the task as
    //    passed, which is the live card the drawer read). An empty patch fires
    //    NO request — just return — so we never trip the server's MISSING_FIELD
    //    (a no-op edit is a closed edit, not an error).
    const changed: EditableFields = {};
    if (patch.title !== undefined && patch.title !== task.title) changed.title = patch.title;
    if (patch.body !== undefined && patch.body !== task.body) changed.body = patch.body;
    if (patch.effort !== undefined && patch.effort !== task.effort) changed.effort = patch.effort;
    if (patch.attendance !== undefined && patch.attendance !== task.attendance)
      changed.attendance = patch.attendance;
    if (Object.keys(changed).length === 0) return;

    // 2. Guard: one in-flight write per card. A pending move OR pending edit on
    //    this uuid means a second write would double-write the card and orphan
    //    the first request — ignore until it resolves (mirrors move()).
    if (get().pending[task.uuid] || get().pendingEdits[task.uuid]) return;

    // The pre-edit values for snap-back, captured from the same live card.
    const prevFields: EditableFields = {};
    if ("title" in changed) prevFields.title = task.title;
    if ("body" in changed) prevFields.body = task.body;
    if ("effort" in changed) prevFields.effort = task.effort;
    if ("attendance" in changed) prevFields.attendance = task.attendance;

    // Head the write is issued against; reconciliation only lets a snapshot that
    // post-dates this head confirm the edit.
    const issuedHead = board.head;

    // 3. Optimistic apply — the card's fields update in place across its lane.
    set({ board: applyOptimisticEdit(board, task.uuid, changed) });

    // Track the pending edit + start the 200ms delay-gate timer (a fast edit
    // confirms via SSE before this fires and never flashes pending).
    const edit: PendingEdit = {
      uuid: task.uuid,
      patch: changed,
      prevFields,
      showPending: false,
      issuedHead,
    };
    set((s) => ({ pendingEdits: { ...s.pendingEdits, [task.uuid]: edit } }));
    clearDelayTimer(task.uuid);
    delayTimers.set(
      task.uuid,
      setTimeout(() => {
        delayTimers.delete(task.uuid);
        set((s) => {
          const p = s.pendingEdits[task.uuid];
          if (!p) return s; // already confirmed/failed
          return { pendingEdits: { ...s.pendingEdits, [task.uuid]: { ...p, showPending: true } } };
        });
      }, PENDING_DELAY_MS),
    );

    // 4. Persist the changed fields. On success we do NOT refetch: the commit's
    //    SSE frame post-dates this write and reconciles it (drops the pending
    //    edit), same as move()/createTask().
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changed),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        const code = errBody?.error?.code ?? `HTTP_${res.status}`;
        const message = errBody?.error?.message ?? `edit failed (${res.status})`;
        throw new EditError(code, message);
      }
      // Success: leave the pending overlay in place; the SSE frame clears it.
    } catch (err) {
      // 5. Failure — snap the card's fields back, clear pending, toast the code.
      clearDelayTimer(task.uuid);
      const code = err instanceof EditError ? err.code : "TRANSPORT_ERROR";
      const message = err instanceof Error ? err.message : String(err);
      set((s) => {
        const { [task.uuid]: _dropped, ...rest } = s.pendingEdits;
        const current = s.board;
        // Snap back ONLY if the card still holds our optimistic values. If a
        // newer authoritative snapshot already superseded the edit, leave the
        // board — the snapshot won (mirrors move()'s stillOptimistic caution).
        const card = current
          ? everyTask(current).find((t) => t.uuid === task.uuid)
          : undefined;
        const stillOptimistic =
          card != null &&
          (changed.title === undefined || card.title === changed.title) &&
          (changed.body === undefined || card.body === changed.body) &&
          (changed.effort === undefined || card.effort === changed.effort) &&
          (changed.attendance === undefined || card.attendance === changed.attendance);
        const snappedBack =
          current && stillOptimistic
            ? applyOptimisticEdit(current, task.uuid, prevFields)
            : current;
        return { board: snappedBack, pendingEdits: rest, toast: { code, message } };
      });
    }
  },

  openCard: (uuid) => set({ selectedUuid: uuid }),
  closeCard: () => set({ selectedUuid: null }),

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

/** Same shape as MoveError, for the create write path. */
class CreateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CreateError";
  }
}

/** Same shape as MoveError, for the drawer-edit write path. */
class EditError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EditError";
  }
}
