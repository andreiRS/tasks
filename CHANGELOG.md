# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-1.0 the surface may still change between minor
versions; breaking changes will be called out explicitly here.

## [Unreleased]

### Added

- Claude Code skill in `skill/` that teaches an agent to track its own
  multi-step work on the board: one task per slice, dependencies wired up,
  cards moved across columns as it goes. Triggers on multi-step jobs and on
  direct board requests; install by symlinking `skill/` into a
  `.claude/skills/` directory. See the README "Claude Code skill" section.
- `tasks serve [--port <n>]` boots a localhost web board for the current
  project's store. It binds to `127.0.0.1` (single-user, no auth), refuses
  to start without an initialized store (`NOT_INITIALIZED`), and prints its
  listening URL on stdout (`--port 0` lets the OS pick). The board is live:
  a single filesystem watch rebroadcasts the full board to every open tab
  over SSE, so terminal and agent changes appear without a refresh. Creating,
  moving, and editing tasks from the board reuse the same git-backed core as
  the CLI (one commit per change). See ADR-0016.
- `tasks new --body <text>` sets the body to a literal string, and
  `--body-file <path>` reads the body from a file (`--body-file -` reads
  stdin). `BODY_FILE_ERROR` is emitted when the file can't be read.

### Changed

- **Breaking:** `tasks new --body -` no longer reads stdin. `--body` is now
  always a literal string, so `--body -` writes a literal `-`. Read stdin via
  `--body-file -` instead. The three body sources (`--body`, `--body-file`,
  `--edit`) are mutually exclusive (`CONFLICT`).

### Fixed

- `tasks serve` now shows the board UI when run from source. A linked or
  source-run `tasks serve` auto-serves a locally-built `web/dist` (after a
  one-time `bun run build:web`), instead of only serving the API and returning a
  bare JSON `NOT_FOUND` at `/`. When no UI is built at all, `serve` prints a
  one-line warning on stderr and serves a short guidance page at `/` explaining
  how to enable the board, rather than a raw error.

## [0.1.0] - 2026-05-29

First versioned release. `tasks` is a single-binary CLI for managing
work as markdown files in a per-project, git-backed store. Every
mutation is a commit, so history and rollback come for free.

### Added

- `tasks init` creates a per-project store under
  `$TASKS_HOME/projects/<encoded-cwd>/` (default `$HOME/.tasks`).
  Idempotent.
- `tasks new <title>` adds a task to `backlog` with `--effort`,
  `--deps`, `--unattended`, `--body -` (stdin), and `--edit` to open
  it in `$EDITOR`.
- `tasks show <id|uuid>` prints a task with its incoming and outgoing
  dependency edges.
- `tasks list` filters by `--column`, `--attendance`, `--effort`,
  `--since <Nd>`, `--all`. Done tasks older than 7 days are hidden by
  default; `--archived` lists archived tasks instead.
- `tasks board` renders a kanban view grouped by column.
- `tasks next` prints the oldest ready task whose dependencies are
  all done, with `--attendance` / `--unattended` filters for agents.
- `tasks mv`, `set`, `link`, `unlink`, `rm` (with `--force` to strip
  dependents) for in-place edits. Each lands as a single commit.
- `tasks edit <id|uuid>` opens the task in `$EDITOR`; `tasks edit
  --abort` discards a pending edit.
- `tasks archive [<id|uuid>] [--before <Nd>]` retires done tasks; the
  no-arg form archives everything eligible.
- `tasks undo` reverts the most recent commit in the store.
- `tasks doctor` reports the store path, git status, and stash count.
- `tasks export --json` dumps the whole store for agents: every live
  task (front matter, body, parsed acceptance criteria), a
  `reverse_deps` index, the current commit SHA, and a `schema_version`.
  Archived tasks are excluded by default but any archived task
  referenced as a dependency is included as a small stub so the
  dependency graph is never dangling. `--include-archived` emits the
  full archive; `--columns a,b,c` narrows the live set.
- `tasks summary --json` prints a compact digest: per-column counts,
  the 10 most recently updated tasks, and tasks in `doing`/`blocked`/
  `review` untouched for 14+ days. Override with `--recent N` and
  `--stale <duration>`.
- `tasks --version` / `-V` / `version` prints the CLI version.
- Safety: mutating commands take a `flock`, refuse to run against a
  dirty tree (`STORE_DIRTY`), and run a validator that rejects cycles
  and unknown dependencies (`CYCLE_DETECTED`, `UNKNOWN_UUID`).
- Commits use your configured git identity when present and fall back to
  a built-in `tasks <tasks@localhost>` identity otherwise, so the store
  works with no setup in fresh environments (CI, containers, agents); a
  failed commit surfaces as `GIT_ERROR` rather than being swallowed.

[Unreleased]: https://github.com/andreiRS/tasks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/andreiRS/tasks/releases/tag/v0.1.0
