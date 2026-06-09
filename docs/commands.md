# Command reference

The full command surface, flags, JSON shapes, and error codes. Source of truth for *what* and *how*. For the domain glossary see [CONTEXT.md](../CONTEXT.md); for the quickstart see [README.md](../README.md).

All read commands accept `--json` (machine-readable envelope on success and failure) and `--no-color`. Color is on when stdout is a TTY; `NO_COLOR` (any value) forces off, `FORCE_COLOR=1` forces on, and `--no-color` / `NO_COLOR` win over `FORCE_COLOR`. `--json` must be explicit, non-TTY stdout does NOT auto-switch.

## `tasks new "<title>" [flags]`

Create a task in `backlog/`. Title must be non-empty, single line, ≤200 characters.

Flags:
- `--title <title>` — compatibility alias for the positional title. Use one or the other, not both.
- `--unattended` — set `attendance: unattended` at creation.
- `--effort <low|medium|high>` — override the default `medium`.
- `--deps <id|uuid>` — repeatable. Validates against the DAG.
- `--edit` — open `$EDITOR` after creation; the create + body edit land in a single commit.
- `--body <text>` — set the body to a literal string.
- `--body-file <path>` — read the body from a file; `--body-file -` reads stdin.

`--body`, `--body-file`, and `--edit` are mutually exclusive (`CONFLICT`). Likewise, the positional title and `--title` are mutually exclusive (`CONFLICT`); provide the title once.

```sh
tasks new "Wire up OAuth flow"
tasks new "Ship release notes" --unattended --effort low --deps 3 --deps 5
tasks new "Wire up OAuth" --body "## Acceptance Criteria\n- OAuth works"
echo "## Acceptance Criteria\n- OAuth works" | tasks new "Wire up OAuth" --body-file -
```

## `tasks show <id|uuid> [--json] [--no-color]`

Print a task. Human output renders the header (id, uuid, column, attendance, effort, timestamps), forward deps as `#id title`, reverse deps (what this task blocks), and the body. `--json` returns the full structured task including parsed `acceptance_criteria`.

## `tasks list [flags]`

Flat list across all six columns. By default hides `done/` tasks whose `updated_at` is older than 7 days.

- `--column <name>` — repeatable, OR-combined. Unknown column emits `INVALID_COLUMN`.
- `--attendance <attended|unattended>` — single value.
- `--effort <low|medium|high>` — single value.
- `--all` — show everything regardless of age.
- `--since <Nd>` — override the cutoff window.
- `--archived` — list only the `archive/` directory instead of the live columns.
- `--json`, `--no-color`.

## `tasks board [--all] [--since <Nd>] [--json] [--no-color]`

Six-column kanban as static print. Same cutoff rules as `list`. Attendance and effort render as compact dim glyphs per row to keep columns tight. `--json` returns `{ backlog: [...], ready: [...], ... }`.

## `tasks mv <id|uuid> <column>`

Move a task. Same-column is a no-op (exit 0, no commit). Bumps `updated_at`. Unknown column emits `INVALID_COLUMN`. Moves do not require deps to be done; the CLI lets you transition freely between any columns.

## `tasks edit <id|uuid> [--abort]`

Open the task file in `$EDITOR`, validate on save, commit. Title change recomputes the slug and performs the content update plus `git mv` in one atomic commit. Invalid saves are rejected with the relevant validator code (`INVALID_TITLE`, `MISSING_FIELD`, `UNKNOWN_UUID`, `CYCLE_DETECTED`, ...) and the bad file is preserved so you can re-run `tasks edit` to fix it.

```sh
EDITOR=vim tasks edit 1
tasks edit --abort   # discard pending edits, reset working tree to HEAD
```

This command is exempt from the dirty-tree guard so it can serve as the recovery path.

## `tasks set <id|uuid> [flags]`

Scalar setter for the three single-field changes that don't need an editor round-trip. At least one flag is required; multiple flags land in one commit.

- `--title <title>` — recomputes the slug and renames the file in the same commit (same semantics as `edit`'s title-change path).
- `--attendance <attended|unattended>`
- `--effort <low|medium|high>`

Deps are mutated via `link`/`unlink`, not `set`.

## `tasks link <id|uuid> --depends-on <id|uuid> [--depends-on ...]`

Add dep edges. `--depends-on` is repeatable; a single invocation produces a single commit. Validates self-links, cycles, and unknown UUIDs before writing.

## `tasks unlink <id|uuid> --depends-on <id|uuid> [--depends-on ...]`

Remove dep edges. Same multi-arg / single-commit semantics.

## `tasks rm <id|uuid> [--force]`

Delete a task. If any task depends on this one, the command refuses with `DEP_EXISTS`. `--force` deletes and strips dangling references from every dependent in the same atomic commit, printing `affected: #<id> <title>` lines to stderr so the cascade is never invisible.

## `tasks init [--json]`

Explicit store creation. Idempotent -- running it a second time is safe and exits 0. Accepts `--json` (returns `{ ok: true, path, created }` where `created` is `true` on first run, `false` on re-run). Note that all mutating commands auto-init silently -- `init` is the explicit escape hatch for scripts that want to ensure the store exists before any tasks are created.

## `tasks undo [--json]`

Reverts HEAD via `git revert --no-edit`, which produces a new commit (no history rewrite). Refuses with `NOTHING_TO_UNDO` on the initial seed commit. Returns `{ ok: true, reverted, revert }` under `--json`, where `reverted` is the SHA that was reverted and `revert` is the new revert commit SHA. `tasks undo` itself is reversible by running it again.

## `tasks next [flags]`

Print the oldest task in `ready/` whose deps are all in `done/`.

- `--attendance <attended|unattended>` — single value.
- `--unattended` — shorthand for `--attendance unattended`. The recommended gate for agent pickup.
- `--json`.

Exits non-zero with `NO_READY_TASK` if no candidate exists.

## `tasks export --json [--include-archived] [--columns <col,col,...>]`

Whole-Store JSON dump intended for agents. One call returns the full live store with everything an agent needs to plan: frontmatter, body, parsed `acceptance_criteria`, forward and reverse deps, the HEAD commit SHA, and a `schema_version`. Tasks are grouped by Column in fixed order (`backlog → ready → doing → blocked → review → done`) and sorted by `created_at` ascending within each group, so successive exports diff cleanly.

Archived Tasks are excluded by default, but any Archived Task referenced as a Dep by a live Task is included as an **Archive Stub** (`{ id, uuid, title, column: "archive", complete: true }`) so the dep graph is never dangling. `--include-archived` emits the full archive (with bodies) as a seventh group. `--columns ready,doing` narrows the live set; stubs still appear for archived deps of the in-scope tasks. `--json` is required (a future human format may land later).

## `tasks summary --json [--recent <N>] [--stale <Nd>]`

Compact Store digest for "what's going on right now?" without dumping every task. Separate envelope from `export`: there is no `tasks` array. Returns:

- `counts`: per-Column task counts plus an `archive` count.
- `recent`: the last 10 live Tasks by `updated_at` (newest first). Minimal stub per entry (`id`, `uuid`, `title`, `column`, `updated_at`). Archive excluded.
- `stale`: live Tasks in `doing`/`blocked`/`review` whose `updated_at` is older than 14 days. Same minimal stub shape. Sorted oldest first. Backlog is allowed to sit; done/archive don't count.

`--recent N` overrides the 10-task default; `--stale <duration>` overrides the 14-day threshold. `--json` is required.

## `tasks archive [<id|uuid>] [--before <Nd>] [--json]`

Retire `done/` tasks into the sibling `archive/` directory (not a Column; transitions never target it). With no args, archives every task currently in `done/`. `--before <Nd>` archives only `done/` tasks whose `updated_at` is older than the cutoff. A single `<id|uuid>` archives just that task, which must be in `done/` (otherwise `INVALID_COLUMN`). All three forms land as a single commit, take the lock, and honor the dirty-tree guard. Archived tasks still count as Complete for blocking purposes. `--json` returns `{ ok: true, archived: [{ id, uuid, title }, ...] }`.

## `tasks doctor [--clean] [--json]`

Store diagnostics and non-destructive recovery; always exits 0. Without flags, prints the store path, `git status --short` of the store, and the count of outstanding `doctor` stashes. `--clean` runs `git stash push --include-untracked` so subsequent mutations no longer hit `STORE_DIRTY`, printing the new stash ref so you can recover with stock `git stash pop`; on an already-clean tree it prints `store already clean` and stashes nothing. `doctor` does not take the lock, does not validate schema, and never deletes files. `--json` returns `{ store, status, stashes }` (or `{ store, stashed, stash_ref }` after a `--clean` stash).

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

Codes: `BODY_FILE_ERROR`, `CONFLICT`, `CYCLE_DETECTED`, `DEP_EXISTS`, `EDITOR_FAILED`, `FLOCK_MISSING`, `GIT_ERROR`, `INVALID_ATTENDANCE`, `INVALID_COLUMN`, `INVALID_EFFORT`, `INVALID_SINCE`, `INVALID_TITLE`, `MISSING_FIELD`, `NO_EDITOR`, `NO_READY_TASK`, `NOT_FOUND`, `NOT_INITIALIZED`, `NOTHING_TO_UNDO`, `SELF_LINK`, `STORE_DIRTY`, `UNDO_FAILED`, `UNKNOWN_UUID`.

`BODY_FILE_ERROR` is emitted when `--body-file <path>` on `new` cannot be read. `CONFLICT` is emitted when more than one of `--body` / `--body-file` / `--edit` are used together on `new`, when the positional title and `--title` are both given on `new`, or when `--unattended` and `--attendance attended` are combined on `next`. `UNDO_FAILED` is emitted by `undo` when `git revert` exits with a conflict.

## JSON output

All read commands (`show`, `list`, `board`, `next`, `export`, `summary`) and all mutating commands (`init`, `new`, `mv`, `edit`, `set`, `link`, `unlink`, `rm`, `undo`, `archive`) accept `--json`. `export` and `summary` *require* it. Errors always use the envelope above. Success shapes per command:

| Command | Success shape |
|---------|--------------|
| `show` | Full task object with parsed `acceptance_criteria` |
| `list` | Array of task objects |
| `board` | `{ backlog: [...], ready: [...], doing: [...], blocked: [...], review: [...], done: [...] }` |
| `next` | Single task object, or non-zero + `NO_READY_TASK` if none |
| `export` | `{ ok: true, schema_version, head_sha, tasks: [...], reverse_deps: {...} }` |
| `summary` | `{ ok: true, schema_version, head_sha, counts: {...}, recent: [...], stale: [...] }` |
| `init` | `{ ok: true, path, created }` (`created: true` on first run) |
| `new` | Plain text `task: new #id - title` (errors use JSON envelope) |
| `mv` | `{ ok: true, id, uuid, from, to }` |
| `edit` | `{ ok: true, id, uuid, changed }` |
| `set` | `{ ok: true, id, uuid, changed }` |
| `link` | `{ ok: true, id, uuid, added }` |
| `unlink` | `{ ok: true, id, uuid, removed }` |
| `rm` | `{ ok: true, id, uuid, forced, cascaded }` |
| `undo` | `{ ok: true, reverted, revert }` |
| `archive` | `{ ok: true, archived: [{ id, uuid, title }, ...] }` |
| `doctor` | `{ store, status, stashes }` (or `{ store, stashed, stash_ref }` on `--clean`) |
