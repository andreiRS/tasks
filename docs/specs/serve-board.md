# `tasks serve` — the paper board

## Problem

Today `tasks` has exactly one interface: the CLI. That serves agents well, but a
human keeping an overview of a project's work has to read `tasks board` /
`tasks list` text dumps and type a `mv` for every change. There's no at-a-glance
spatial view of where everything sits, and no live picture of work moving as
agents pick tasks up and push them through columns. A human supervising one or
more agents wants to *watch* the board update and occasionally reach in to move,
add, or tweak a task without dropping to the terminal.

A visual companion gives humans a second, spatial way to operate the same store:
six columns of post-it cards that update in real time as anyone (a human in the
browser, an agent on the CLI) commits a change.

**Confidence:** assumption — based on the product intent that humans and agents
share one store, not on usage data.

## Solution

Add a `tasks serve` command that starts a local Bun HTTP server scoped to the
current project's Store. The server **imports the existing core**
(`store.ts`, `queries.ts`, `validation.ts`) in-process, so every write from the
browser flows through the exact same `flock → dirty-guard → validate → commit`
path as the CLI. The board and the CLI can never disagree about what a write is
allowed to do, and git stays the single source of truth.

A React + Vite + dnd-kit frontend renders the Store as six lanes of paper cards
in the handwritten, physical-post-it style of the reference prototype. Reads come
from a board snapshot; live updates come from the server watching the Store
directory (`fs.watch` → debounce → re-read → broadcast a full snapshot over SSE),
so an agent's `tasks mv` shows up on every open board within a moment. Writes
(move, create, edit) are plain POST/PATCH calls that reuse the core mutations;
the UI applies them optimistically and reconciles against the authoritative SSE
snapshot.

The frontend is built by Vite and **embedded into the single `tasks` binary** via
`bun build --compile`, preserving the single-binary distribution. Dev uses the
Vite dev server with an `/api` proxy.

## Scope

### In scope

- As a human, I can run `tasks serve` to open a live web board of the current
  project's Store in my browser.
- As a human, I can see all six Columns (backlog, ready, doing, blocked, review,
  done) as lanes, each card showing its Short ID, title, a short body preview,
  Effort (color dot), an "blocked by #N" badge when it has unresolved blockers,
  an Attendance marker, and how long ago it was updated.
- As a human, I can drag a card between lanes to perform a Transition, and it
  moves instantly (optimistic), reconciling against the server's committed state.
- As a human, I can watch the board update on its own as agents (or another
  viewer) move, create, or edit tasks, with no manual refresh.
- As a human, I can create a task from the board (title + body + Effort), landing
  in backlog like `tasks new`.
- As a human, I can open a card's drawer to read its rendered-markdown body
  (acceptance criteria included) and edit its title, body, Effort, and Attendance.
- As a human, I get a clear toast and a snap-back if a write fails (e.g. the
  Store is dirty) so I'm never misled about what persisted.

### Out of scope

- Editing Dependencies (link/unlink), archiving, and undo — CLI-only in v1; the
  drawer shows deps and column read-only.
- Manual within-lane reordering — the Store has no per-Column order; cards sort
  oldest-first (created_at asc) so the top of `ready` equals `tasks next`.
- Search and filters in the toolbar — none in v1.
- Multi-project switching — one `serve` process serves one project's Store.
- Auto-init — `serve` refuses to start if the project has no Store.
- Any change to the CLI's own behavior, the on-disk format, or the frontmatter
  schema. The board is a new reader/writer over the existing model, not a model
  change.
- Authentication / remote access — binds to localhost only, single user.

## Success Criteria

- Running `tasks serve` in a project with a Store opens a board that renders the
  current tasks correctly across all six lanes.
- Dragging a card to another lane produces exactly one git commit in the Store,
  identical to what `tasks mv` would produce, and the move survives reload.
- An out-of-band `tasks mv` from a separate process updates every open board over
  SSE without a manual refresh. *(This is the riskiest, highest-value signal.)*
- Creating and editing tasks from the board produces the same on-disk result and
  single-commit-per-mutation as the equivalent CLI commands.
- A failed write (e.g. dirty Store) reverts the optimistic change and surfaces the
  error code to the user; the board never shows a state that didn't persist.
- `tasks serve` refuses to start with a clear message when no Store exists.
- The shipped artifact is still a single self-contained binary.

## Constraints

- Reuse the existing mutation core in-process; do not shell out to the CLI and do
  not fork the lock/validate/commit logic.
- Honor the existing model exactly: six fixed Columns, open Transitions
  (ADR-0005), deps Complete only in `done`, Archive hidden (not a Column).
- Single-binary distribution via `bun build --compile` must be preserved; embed
  built frontend assets in the binary.
- Bind to localhost; no auth, no remote exposure in v1.
- Testing follows the project's HTTP-boundary TDD: spawn `tasks serve` against a
  `TASKS_HOME` tempdir and assert on JSON responses and on-disk git state; no
  mocking of git.

## Open Questions / Risks

- **Dependency-surface ADR.** ADR-0014 commits to a deliberately small dependency
  surface. Adding React, Vite, dnd-kit, and a markdown renderer is a meaningful
  reversal for the `serve` subsystem. This should be recorded as a new ADR (the
  local board server: in-process core reuse, SSE live sync, localhost-only,
  embedded assets) that scopes the larger frontend dependency set to `serve`.
- **`fs.watch` reliability on macOS.** Coalescing and `.git`-internal writes can
  cause missed or noisy events. The debounce-and-re-read-full-snapshot design is
  meant to be robust to this, but it needs validation under real agent activity.
- **Optimistic-vs-committed latency under lock contention.** If an agent holds the
  flock during a long operation, a browser write blocks until the lock frees; the
  UI must keep the optimistic state pending without appearing broken.
