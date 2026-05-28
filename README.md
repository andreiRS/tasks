# tasks

A git-backed, file-per-task CLI for tracking work across six columns, designed so humans and Claude Code agents drive the same surface. Each task is a markdown file with YAML frontmatter, kept in a per-project git repository under `$TASKS_HOME`. Every mutation is an atomic commit, so the history is the audit log.

> **Status:** M1 through M9 are complete. M10 (Ship polish pass) is in progress. The store, validator (schema + DAG rules), all read commands (`show`, `list`, `board`, `next`), and all write commands (`init`, `new`, `mv`, `edit`, `set`, `link`, `unlink`, `rm`, `undo`) are live. See [MILESTONES.md](./MILESTONES.md) for the full delivery plan and per-milestone status.

## Why

- Tasks live in plain files you can grep, diff, and back up.
- The store is a git repo, so `git log` shows exactly what changed and when.
- The same CLI is driven by humans (short IDs, human renderer) and agents (UUIDs, `--json`, stable error codes).
- Open transitions, strict DAG: the validator protects the graph, not the workflow.

## How it works

- The **Store** directory is keyed off the **Project root**, defined as the nearest ancestor of `pwd` that contains a `.git/` (falling back to `pwd`).
- Stores live under `$TASKS_HOME/projects/<encoded-path>/`. Path encoding doubles literal `-` and then turns `/` into `-`, so collisions like `/a-b/c` vs `/a/b/c` cannot happen and the encoding is reversible.
- Each task is a markdown file in one of six **Column** directories: `backlog`, `ready`, `doing`, `blocked`, `review`, `done`. Moving columns is a `git mv`.
- A task has two identifiers: a per-project **Short ID** (monotonic, never reused, allocated atomically via `meta.yaml`) and a stable **UUID** (used for all `deps` references).
- An **flock**-based lock serializes mutating commands. The dirty-tree guard runs *after* the lock so concurrent invocations serialize cleanly.

See [CONTEXT.md](./CONTEXT.md) for the full glossary and [docs/adr/](./docs/adr/) for the recorded design decisions.

## Requirements

- [Bun](https://bun.sh) 1.3.13 or newer
- `flock` on `PATH` (macOS: `brew install flock`)
- `git`

## Install and run

From the repo root:

```sh
bun install
bun link                # exposes `tasks` on $PATH (uses package.json's bin entry)
tasks --help
```

After linking, every example below works as written: `tasks new "..."`, `tasks list`, etc.

For a standalone binary (no Bun required at runtime):

```sh
bun run build           # produces dist/tasks
./dist/tasks --help
```

If you'd rather not link, you can always invoke the entry point directly while developing:

```sh
bun run src/cli.ts <command> [...args]
```

Set `$TASKS_HOME` to choose where stores live (defaults to `~/.tasks`, so the on-disk layout is `~/.tasks/projects/<encoded-project-root>/`, mirroring Claude Code's per-project convention under `~/.claude/projects/`). Tests rely on this override for hermetic tempdirs.

## Frontmatter shape

```yaml
id: 42
uuid: 7f3a9c2e-...
title: add OAuth flow
deps: ["uuid-a", "uuid-b"]
attendance: attended      # or "unattended" (agent pickup gate)
effort: medium            # low | medium | high
created_at: 2026-05-27T10:14:00Z
updated_at: 2026-05-27T10:14:00Z
```

`id`, `uuid`, `title`, `created_at`, `updated_at` are required. `deps` defaults to `[]`, `attendance` to `attended`, `effort` to `medium`. Body is free-form markdown; a `## Acceptance Criteria` section is parsed out into `acceptance_criteria` on `--json` reads.

## Commands

All read commands accept `--json` (machine-readable envelope on success and failure) and `--no-color`. Color is on when stdout is a TTY; `NO_COLOR` (any value) forces off, `FORCE_COLOR=1` forces on, and `--no-color` / `NO_COLOR` win over `FORCE_COLOR`. `--json` must be explicit, non-TTY stdout does NOT auto-switch.

### `tasks new "<title>" [flags]`

Create a task in `backlog/`. Title must be non-empty, single line, ≤200 characters.

Flags:
- `--unattended` — set `attendance: unattended` at creation.
- `--effort <low|medium|high>` — override the default `medium`.
- `--deps <id|uuid>` — repeatable. Validates against the DAG.
- `--edit` — open `$EDITOR` after creation; the create + body edit land in a single commit.
- `--body -` — read the body from stdin.

```sh
tasks new "Wire up OAuth flow"
tasks new "Ship release notes" --unattended --effort low --deps 3 --deps 5
echo "## Acceptance Criteria\n- OAuth works" | tasks new "Wire up OAuth" --body -
```

### `tasks show <id|uuid> [--json] [--no-color]`

Print a task. Human output renders the header (id, uuid, column, attendance, effort, timestamps), forward deps as `#id title`, reverse deps (what this task blocks), and the body. `--json` returns the full structured task including parsed `acceptance_criteria`.

### `tasks list [flags]`

Flat list across all six columns. By default hides `done/` tasks whose `updated_at` is older than 7 days.

- `--column <name>` — repeatable, OR-combined. Unknown column emits `INVALID_COLUMN`.
- `--attendance <attended|unattended>` — single value.
- `--effort <low|medium|high>` — single value.
- `--all` — show everything regardless of age.
- `--since <Nd>` — override the cutoff window.
- `--json`, `--no-color`.

### `tasks board [--all] [--since <Nd>] [--json] [--no-color]`

Six-column kanban as static print. Same cutoff rules as `list`. Attendance and effort render as compact dim glyphs per row to keep columns tight. `--json` returns `{ backlog: [...], ready: [...], ... }`.

### `tasks mv <id|uuid> <column>`

Move a task. Same-column is a no-op (exit 0, no commit). Bumps `updated_at`. Unknown column emits `INVALID_COLUMN`. Open transitions: the CLI does not enforce dep-completeness on moves (see ADR 0005).

### `tasks edit <id|uuid> [--abort]`

Open the task file in `$EDITOR`, validate on save, commit. Title change recomputes the slug and performs the content update plus `git mv` in one atomic commit. Invalid saves are rejected with the relevant validator code (`INVALID_TITLE`, `MISSING_FIELD`, `UNKNOWN_UUID`, `CYCLE_DETECTED`, ...) and the bad file is preserved so you can re-run `tasks edit` to fix it.

```sh
EDITOR=vim tasks edit 1
tasks edit --abort   # discard pending edits, reset working tree to HEAD
```

This command is exempt from the dirty-tree guard so it can serve as the recovery path.

### `tasks set <id|uuid> [flags]`

Scalar setter for the three single-field changes that don't need an editor round-trip. At least one flag is required; multiple flags land in one commit.

- `--title <title>` — recomputes the slug and renames the file in the same commit (same semantics as `edit`'s title-change path).
- `--attendance <attended|unattended>`
- `--effort <low|medium|high>`

Deps are mutated via `link`/`unlink`, not `set`.

### `tasks link <id|uuid> --depends-on <id|uuid> [--depends-on ...]`

Add dep edges. `--depends-on` is repeatable; a single invocation produces a single commit. Validates self-links, cycles, and unknown UUIDs before writing.

### `tasks unlink <id|uuid> --depends-on <id|uuid> [--depends-on ...]`

Remove dep edges. Same multi-arg / single-commit semantics.

### `tasks rm <id|uuid> [--force]`

Delete a task. If any task depends on this one, the command refuses with `DEP_EXISTS`. `--force` deletes and strips dangling references from every dependent in the same atomic commit, printing `affected: #<id> <title>` lines to stderr so the cascade is never invisible.

### `tasks init [--json]`

Explicit store creation. Idempotent -- running it a second time is safe and exits 0. Accepts `--json` (returns `{ ok: true, path, created }` where `created` is `true` on first run, `false` on re-run). Note that all mutating commands auto-init silently -- `init` is the explicit escape hatch for scripts that want to ensure the store exists before any tasks are created.

### `tasks undo [--json]`

Reverts HEAD via `git revert --no-edit`, which produces a new commit (no history rewrite). Refuses with `NOTHING_TO_UNDO` on the initial seed commit. Returns `{ ok: true, reverted, revert }` under `--json`, where `reverted` is the SHA that was reverted and `revert` is the new revert commit SHA. `tasks undo` itself is reversible by running it again.

### `tasks next [flags]`

Print the oldest task in `ready/` whose deps are all in `done/`.

- `--attendance <attended|unattended>` — single value.
- `--unattended` — shorthand for `--attendance unattended`. The recommended gate for agent pickup.
- `--json`.

Exits non-zero with `NO_READY_TASK` if no candidate exists.

## Safety rails

- **flock**: every mutating command takes an exclusive lock on the store. Concurrent invocations serialize. Missing `flock` on `$PATH` emits `FLOCK_MISSING` with the install hint.
- **Dirty-tree guard**: mutations refuse with `STORE_DIRTY` if the store working tree has uncommitted changes. `edit` is intentionally exempt; use `tasks edit --abort` to reset.
- **Schema validator**: required fields and title constraints are enforced on every write.
- **DAG validator**: every mutation that could change the graph rebuilds it and rejects with `CYCLE_DETECTED` or `UNKNOWN_UUID` before committing.
- **Atomicity**: every successful mutation is a single git commit. The lock guards ID allocation, validation, file writes, and the commit as one critical section.

## Error envelope

With `--json`, errors come back as:

```json
{ "error": { "code": "CYCLE_DETECTED", "message": "...", "details": {} } }
```

Without `--json`, errors are plain text on stderr. Either way the exit code is non-zero.

Codes: `CONFLICT`, `CYCLE_DETECTED`, `DEP_EXISTS`, `EDITOR_FAILED`, `FLOCK_MISSING`, `GIT_ERROR`, `INVALID_ATTENDANCE`, `INVALID_COLUMN`, `INVALID_EFFORT`, `INVALID_SINCE`, `INVALID_TITLE`, `MISSING_FIELD`, `NO_EDITOR`, `NO_READY_TASK`, `NOT_FOUND`, `NOT_INITIALIZED`, `NOTHING_TO_UNDO`, `SELF_LINK`, `STORE_DIRTY`, `UNDO_FAILED`, `UNKNOWN_UUID`.

`CONFLICT` is emitted when `--edit` and `--body -` are used together on `new`, or when `--unattended` and `--attendance attended` are combined on `next`. `UNDO_FAILED` is emitted by `undo` when `git revert` exits with a conflict.

## JSON output

All read commands (`show`, `list`, `board`, `next`) and all mutating commands (`init`, `new`, `mv`, `edit`, `set`, `link`, `unlink`, `rm`, `undo`) accept `--json`. Errors always use the envelope above. Success shapes per command:

| Command | Success shape |
|---------|--------------|
| `show` | Full task object with parsed `acceptance_criteria` |
| `list` | Array of task objects |
| `board` | `{ backlog: [...], ready: [...], doing: [...], blocked: [...], review: [...], done: [...] }` |
| `next` | Single task object, or non-zero + `NO_READY_TASK` if none |
| `init` | `{ ok: true, path, created }` (`created: true` on first run) |
| `new` | Plain text `task: new #id - title` (errors use JSON envelope) |
| `mv` | `{ ok: true, id, uuid, from, to }` |
| `edit` | `{ ok: true, id, uuid, changed }` |
| `set` | `{ ok: true, id, uuid, changed }` |
| `link` | `{ ok: true, id, uuid, added }` |
| `unlink` | `{ ok: true, id, uuid, removed }` |
| `rm` | `{ ok: true, id, uuid, forced, cascaded }` |
| `undo` | `{ ok: true, reverted, revert }` |

## Tests

```sh
bun test
bunx tsc --noEmit
```

Tests spawn the CLI via `Bun.spawn` against a tempdir `TASKS_HOME` and assert on stdout, stderr, exit codes, and on-disk state. No git mocking. No assertions on internal modules. See [MILESTONES.md](./MILESTONES.md) for the TDD working method (one commit per green state, refactors only from green).

## Layout

```
src/
  cli.ts         command dispatch + argument parsing
  store.ts       path resolver, encoding, store ops, validator, flock wrapper
  render.ts      human renderers for show / list / board / next, color helpers
  acceptance.ts  hand-rolled fence-aware Acceptance Criteria parser
tests/           CLI-level integration tests
docs/adr/        Architecture Decision Records
PRD.md           product spec
CONTEXT.md       glossary (canonical terms)
MILESTONES.md    delivery plan + status
CLAUDE.md        agent-facing pointer file
```

## License

Private.
