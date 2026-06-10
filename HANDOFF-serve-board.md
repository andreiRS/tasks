# Handoff — `tasks serve` visual board implementation

You are in the git worktree `/Users/razvan.surdu/Projects/tasks-serve-board` on branch **`feat/serve-board`**. The planning is done and committed here; your job is to **orchestrate the implementation**.

## ⚠️ Standing instruction for every implementation agent

**Before adding or using any library, confirm the latest version and current API via the context7 MCP** — call `resolve-library-id` then `query-docs` (or the `mcp__context7__*` / `mcp__plugin_context7_context7__*` tools). Do **not** rely on training-data memory for library APIs. This matters most for the frontend stack introduced in this feature: **React 19, Vite, dnd-kit, and the markdown renderer** (issues #25, #18, #22). When you spawn agents via `/orchestrate-tdd`, pass this instruction into each one.

## What this is

A second way to operate the `tasks` CLI: a localhost web Kanban board (`tasks serve`) that humans use to watch and move tasks while agents drive the same Store from the CLI. It reuses the CLI's mutation core **in-process**, so a browser drag and a `tasks mv` hit the same flock → dirty-guard → validate → commit path. Git stays the single source of truth.

## Read these first (all committed on this branch)

- `docs/specs/serve-board.md` — the spec (problem, scope, success criteria, risks).
- `docs/adr/0016-board-server-reuses-core-in-process.md` — the architecture decision (in-process reuse, SSE live sync, embedded Vite assets, localhost-only). Qualifies ADR-0014; realizes the library API ADR-0002 deferred.
- `CONTEXT.md` — glossary; note the clarified **`blocked` Column vs Unresolved Blocker** distinction (orthogonal: a derived blocked-by badge can ride a card in any Column).
- `CLAUDE.md` — the project working method: **TDD outside-in at the CLI/HTTP boundary** (spawn the binary / `tasks serve` against a `TASKS_HOME` tempdir, assert on JSON + stdout/exit codes + on-disk git state; no mocking of git). One commit per green state: `green: <behavior>` / `refactor: <what>`. Always `bun`, never `npm`.

## The work — 14 issues, label `serve-board`, in `andreiRS/tasks`

`gh issue list --label serve-board --state open` to see them. Dependency-ordered:

- **#13** server boot + `GET /api/board` snapshot + no-store refusal — **unblocked, start here.** Owns the `TasksError`→HTTP envelope mapping; must NOT route through the CLI `emit()`/`process.exit` path. Blocked-by must be archive-aware.
- **#14** `POST /tasks/:id/move` · **#15** `POST /tasks` (create) · **#16** `PATCH /tasks/:id` (edit) — backend writes (depend on #13).
- **#17** `GET /api/events` SSE live sync (the riskiest; out-of-band `tasks mv` proof) — depends on #13, **#24**.
- **#18** board UI (six lanes, post-it styling) — depends on #13, **#25**.
- **#19** drag-to-move · **#20** live board via SSE · **#21** new-task modal · **#22** card drawer (markdown + inline edit) · **#23** write-failure UX.

### Pause for human input on these three ATTENDED decision slices (labeled `question`)

`/orchestrate-tdd` must **stop and ask the human** before implementing the work these gate:

- **#24** — fs.watch strategy on macOS (watched paths, `.git` noise, debounce). Gates #17.
- **#25** — frontend toolchain + Vite-assets-embedded-in-binary + dev `/api` proxy. **Unblocked, can start in parallel with #13.** Gates ALL UI (#18→#23). Use context7 to pin React/Vite/dnd-kit versions here.
- **#26** — optimistic reconcile + lock-contention pending behavior. Gates #19, #20.

**Two unblocked roots to begin: #13 (backend) and #25 (frontend decision).**

## Decisions already locked (from the grilling — don't re-litigate)

- Delivery: local Bun server (`tasks serve`), React + Vite + dnd-kit, assets embedded in the single binary.
- All **6 lanes**, horizontal scroll; **no within-lane reorder** (fixed sort oldest-first / created_at asc, so top of `ready` == `tasks next`); **no search/filters** in v1.
- Writes = move + create + edit. Deps-editing, archive, undo stay CLI-only.
- All transitions legal (ADR-0005); dragging a still-blocked card forward is allowed, badge travels with it.
- Optimistic drag, SSE snapshot is authoritative, snap-back + toast on failure. STORE_DIRTY → per-action toast (no banner).
- Card color + tilt seeded from task id (stable). Body shown as rendered markdown, edited as raw textarea.
- `serve` refuses to start when no Store exists.

## Final-review blocker (already resolved in the issues)

The plan review found that **editing a Task body has no programmatic core path** (`editTask` is `$EDITOR`-only; `setTask` covers title/attendance/effort but not body; `TaskFile.bodyRaw` is private). This was folded into **#16** (re-scoped to add the core body-edit capability, resized S→M). When you reach #16, implement that core extension (a `body?` set option + a `TaskFile` body setter writing through `commitTaskChange`) before/with the PATCH endpoint.

## Suggested skills for the next session

1. **`/orchestrate-tdd`** — drive the issues to completion, one verified slice at a time, pausing on #24/#25/#26. Start with #13 and #25.
2. **`/implement-tdd`** — per-slice red→green→refactor (orchestrate-tdd invokes this per slice).
3. **`/code-review`** and **`/verify`** (or `/prove-it`) — between slices, before advancing.

## State

- Branch `feat/serve-board`, 3 doc commits on top of `main@db42100`. Nothing pushed yet.
- No code written. No PR opened.
