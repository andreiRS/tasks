# `tasks serve` — board write-interaction spec (#26)

The interaction contract for every board **write** (move, create, edit). The
drag (#19), create-modal (#21), drawer-edit (#22), and write-failure (#23)
slices implement against this. Read alongside `serve-board.md` (the feature
spec) and `docs/adr/0016-board-server-reuses-core-in-process.md`.

## Model in one line

Apply the change **optimistically** in the browser, fire the POST/PATCH, and
treat the server's **SSE full-snapshot** as the single source of truth. The
local optimistic state is a temporary overlay that the next authoritative
snapshot replaces wholesale.

## 1. Optimistic apply

On a user write the UI updates immediately, before the network round-trip:

- **Move**: the card appears in the target lane at once (it already sorts
  oldest-first there once the snapshot lands; optimistic placement may append to
  the target lane — the reconciling snapshot fixes final order).
- **Create**: a placeholder card appears in `backlog`. It has no real short id
  yet; render it with a muted/placeholder id until the snapshot assigns one.
- **Edit**: the card's fields update in place.

Each optimistic change is tracked as a **pending write** keyed by the task uuid
(create uses a temporary client key until the server returns the uuid).

## 2. Pending / in-flight visual  — *decision*

A pending card stays in its **target** lane and reads as "saving…", never as
broken:

- **opacity ~0.6**, plus a small corner **spinner/clock badge** (◷). No border
  or layout change — the card does not jump.
- **Delay-gated (~200ms).** The pending visual only appears if the write has not
  confirmed within ~200ms. Fast writes (the common path) confirm first and never
  flash an indicator; only genuinely slow writes — chiefly **lock contention**,
  see §4 — ever show it. Implement as a 200ms timer started at write time and
  cleared on confirm/failure.

## 3. Reconciliation against the authoritative snapshot

The server broadcasts a full `BoardSnapshot` over `GET /api/events` after every
committed mutation (and on connect). The board **re-renders wholesale** from each
snapshot; reconciliation is idempotent (re-applying the same snapshot is a
no-op). On each snapshot:

- A pending write whose effect is **present** in the snapshot → clear its pending
  state (and its 200ms timer). The optimistic overlay and the snapshot now agree.
- A pending write still **absent** from a *newer* snapshot that post-dates the
  write's commit → it was superseded or never landed; see §5.
- Anything not covered by a pending write → take the snapshot value verbatim. The
  snapshot always wins over stale local state.

Because the snapshot is authoritative and full, the UI never needs to merge
field-by-field: replace the board, then re-overlay only the still-pending writes.

## 4. Lock contention — stays pending, not broken  — *acceptance*

The core mutation path takes a **blocking** flock (`flock -x`, no `-w`). If an
agent (or another browser write) holds the lock, the server request **blocks**
until the lock frees, then commits — it does not error. So a contended write:

- keeps its optimistic state applied,
- crosses the ~200ms threshold and shows the subtle pending badge,
- resolves normally when the lock frees and the commit's snapshot arrives (§3).

The UI must **not** time out, retry, or surface an error purely because a write
is slow. Pending is a valid, expected steady state for as long as the lock is
held. (A future hard ceiling, if ever needed, is out of scope here.)

## 5. Conflict resolution — last-write-wins, server authoritative  — *acceptance*

- **Server snapshot wins.** There is no client-side merge. The committed state in
  git, surfaced via the snapshot, is truth.
- **Failure** (HTTP error envelope, e.g. `STORE_DIRTY`, `INVALID_COLUMN`, or a
  transport error): **snap the card back** to its pre-write position/values and
  show a **toast** carrying the error `code` (and message). Clear the pending
  state. The board never persists a state the server rejected.
- **Supersede** (the write succeeded locally but a newer authoritative snapshot
  reflects a different outcome — e.g. another actor moved the same card first):
  the snapshot wins; the local card snaps to the snapshot's position. A toast is
  shown only when the user's own change was discarded, so they are never misled
  about what persisted.
- **Last-write-wins** is the rule for concurrent edits to the same task: whichever
  mutation commits last is what the store (and every board) ends up showing.

## What each downstream slice owes this spec

- **#19 drag-to-move**: optimistic lane move + pending overlay + snap-back on
  failure, reconciling against SSE.
- **#20 live board (SSE)**: the wholesale re-render + idempotent reconcile in §3,
  including clearing pending writes the snapshot confirms. Guard against an
  overlapping/stale snapshot load clobbering a newer one (carried over from the
  #18 review).
- **#21 create modal / #22 drawer edit**: optimistic create/edit using the same
  pending-write tracking and reconciliation.
- **#23 write-failure UX**: the toast + snap-back of §5, surfacing the error code.
