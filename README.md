# tasks

A git-backed, file-per-task CLI for tracking work across six columns. Each task is a markdown file with YAML frontmatter, kept in a per-project git repository under `$TASKS_HOME`. Every mutation is an atomic commit, so the history is the audit log.

> Status: work in progress. M1 through M7a are implemented (capture/inspect, human renderer, list, filters/board/cutoff, move, edit/delete, DAG validator + rm cascade). Link/unlink and later milestones are not built yet.

## Why

- Tasks live in plain files you can grep, diff, and back up.
- The store is a git repo, so `git log` shows exactly what changed and when.
- Designed to be driven by humans and agents from the same CLI surface.

## How it works

- The store directory is keyed off your project root, defined as the nearest ancestor of the current directory that contains a `.git/` (falling back to `cwd`).
- Stores live under `$TASKS_HOME/projects/<encoded-path>/` (path encoding doubles literal `-` and turns `/` into `-`, so it is reversible).
- Each task is a file in one of six column directories: `backlog`, `ready`, `doing`, `blocked`, `review`, `done`.
- An `flock`-based lock serializes mutating commands so concurrent invocations cannot corrupt the store.

## Requirements

- [Bun](https://bun.sh) 1.3.13 or newer
- `flock` on `PATH` (macOS: `brew install flock`)
- `git`

## Install and run

From the repo root:

```sh
bun install
bun run tasks --help   # not implemented yet; see commands below
```

While developing, invoke commands via the bun script:

```sh
bun run tasks <command> [...args]
```

A compiled single-file binary is wired up in `package.json`:

```sh
bun run build           # produces dist/tasks
./dist/tasks <command>
```

You can set `$TASKS_HOME` to choose where stores live (default is the platform-appropriate location; see `src/store.ts`).

## Commands

All commands accept `--json` (machine-readable envelope on success and failure). All read commands accept `--no-color`; output is plain when stdout is not a TTY. `NO_COLOR` (any value) and `FORCE_COLOR=1` are honored, with `--no-color` and `NO_COLOR` winning over `FORCE_COLOR`.

### `tasks new "<title>"`

Create a new task in `backlog`. Title must be non-empty, single line, and at most 200 characters.

```sh
bun run tasks new "Wire up OAuth flow"
```

### `tasks show <id|uuid> [--json] [--no-color]`

Print a task. Human output renders the title, metadata block, and body. `--json` returns the normalized task object.

```sh
bun run tasks show 1
bun run tasks show 1 --json
```

### `tasks list [--column <name>]... [--all] [--since <Nd>] [--json] [--no-color]`

List tasks. By default, lists every column but hides `done` tasks whose `updated_at` is older than 7 days.

- `--column <name>` filters by column. Repeatable, OR-combined. Unknown column emits `INVALID_COLUMN`.
- `--all` shows everything regardless of age.
- `--since 30d` overrides the cutoff window.

```sh
bun run tasks list
bun run tasks list --column doing --column review
bun run tasks list --since 30d
bun run tasks list --json
```

### `tasks board [--all] [--since <Nd>] [--json] [--no-color]`

Render all six columns as stacked sections. Same cutoff rules as `list`. `--json` returns `{ backlog: TaskData[], ready: ..., doing: ..., blocked: ..., review: ..., done: ... }`.

```sh
bun run tasks board
bun run tasks board --json
```

### `tasks mv <id|uuid> <column>`

Move a task between columns. Same-column is a no-op (exit 0, no commit). Bumps `updated_at`. Unknown column emits `INVALID_COLUMN`.

```sh
bun run tasks mv 1 ready
bun run tasks mv 1 doing
```

### `tasks edit <id|uuid>`

Open the task file in `$EDITOR`, validate on save, and commit. Title validation runs again; invalid saves are rejected with `INVALID_TITLE` and the bad file is preserved on disk so you can fix it. A title change recomputes the slug, performs the content update plus `git mv`, and commits both in one atomic step.

```sh
EDITOR=vim bun run tasks edit 1
bun run tasks edit --abort   # discard pending edits, reset working tree to HEAD
```

This command is exempt from the dirty-tree guard.

### `tasks rm <id|uuid> [--force]`

Delete a task and commit. If any task depends on this one, the command refuses with `DEP_EXISTS`. `--force` deletes and strips dangling references from every dependent in the same atomic commit, printing `affected: #<id> <title>` lines to stderr.

```sh
bun run tasks rm 3
bun run tasks rm 3 --force
```

## Safety rails

- **flock**: every mutating command (`new`, `mv`, `edit`, `rm`) takes an exclusive lock on the store. Concurrent invocations serialize cleanly.
- **Dirty-tree guard**: mutations refuse with `STORE_DIRTY` if the store working tree has uncommitted changes (`edit` is intentionally exempt; use `tasks edit --abort` to reset).
- **DAG validator**: every mutation that could change the graph rebuilds it and rejects with `CYCLE_DETECTED` or `UNKNOWN_UUID` before committing.
- **Atomicity**: every successful mutation is a single git commit.

## Error envelope

With `--json`, errors come back as:

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "..." } }
```

Codes used so far: `NOT_FOUND`, `INVALID_TITLE`, `INVALID_COLUMN`, `UNKNOWN_COLUMN`, `INVALID_SINCE`, `STORE_DIRTY`, `FLOCK_MISSING`, `NOT_INITIALIZED`, `MISSING_FIELD`, `NO_EDITOR`, `EDITOR_FAILED`, `UNKNOWN_UUID`, `CYCLE_DETECTED`, `DEP_EXISTS`.

## Tests

```sh
bun test
bunx tsc --noEmit
```

Tests spawn the CLI through `Bun.spawn` against a tempdir `TASKS_HOME` and assert on stdout, stderr, exit codes, and on-disk state. There is no git mocking and no assertion on internal modules from the CLI tests.

## Layout

```
src/
  cli.ts       command dispatch + argument parsing
  store.ts     path resolver, encoding, store ops, validator, flock wrapper
  render.ts    human renderers for show / list / board, color helpers
tests/         CLI-level integration tests
PRD.md         product spec
MILESTONES.md  delivery plan
```

## License

Private.
