# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-1.0 the surface may still change between minor
versions; breaking changes will be called out explicitly here.

## [Unreleased]

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

[Unreleased]: https://github.com/andreiRS/tasks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/andreiRS/tasks/releases/tag/v0.1.0
