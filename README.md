# tasks

A git-backed, file-per-task CLI for tracking work across six columns, designed so humans and Claude Code agents drive the same surface. Each task is a markdown file with YAML frontmatter, kept in a per-project git repository under `$TASKS_HOME`. Every mutation is an atomic commit, so the history is the audit log.

## Why

- Tasks live in plain files you can grep, diff, and back up.
- The store is a git repo, so `git log` shows exactly what changed and when.
- The same CLI is driven by humans (short IDs, human renderer) and agents (UUIDs, `--json`, stable error codes).
- Open transitions, strict DAG: the validator protects the graph, not the workflow.

The store directory is keyed off the **Project root** (nearest ancestor of `pwd` with a `.git/`, else `pwd`), under `$TASKS_HOME/projects/<encoded-path>/`. Each task lives in one of six **Column** directories (`backlog`, `ready`, `doing`, `blocked`, `review`, `done`); moving columns is a `git mv`. See [CONTEXT.md](./CONTEXT.md) for the full glossary.

## Requirements

- [Bun](https://bun.sh) 1.3.13 or newer
- `flock` on `PATH` (macOS: `brew install flock`)
- `git`

## Install

From the repo root:

```sh
bun install
bun link                # exposes `tasks` on $PATH
tasks --help
```

For a standalone binary (no Bun at runtime): `bun run build` produces `dist/tasks`. To run without linking while developing: `bun run src/cli.ts <command> [...args]`.

Environment:
- `$TASKS_HOME` — where stores live (default `~/.tasks`). Tests override it for hermetic tempdirs.
- `$TASKS_NOW` — ISO-8601 timestamp that freezes the clock for `created_at`/`updated_at` and the `done` cutoff window; unparseable values are ignored. See [ADR-0015](./docs/adr/0015-injectable-clock-via-tasks-now.md).

## Quickstart

```sh
tasks new "Wire up OAuth flow"                       # create in backlog
tasks new "Ship notes" --unattended --effort low --deps 3
tasks mv 1 doing                                     # move a column
tasks link 2 --depends-on 1                          # add a dep edge
tasks next --unattended                              # oldest ready, agent-safe
tasks export --json                                  # whole store for agents
```

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

`id`, `uuid`, `title`, `created_at`, `updated_at` are required. `deps` defaults to `[]`, `attendance` to `attended`, `effort` to `medium`. Body is free-form markdown; a `## Acceptance Criteria` section is parsed into `acceptance_criteria` on `--json` reads.

## Reference

- [docs/commands.md](./docs/commands.md) — every command, flag, JSON shape, and error code. Also `tasks --help` and `tasks <command> --help`.
- [CONTEXT.md](./CONTEXT.md) — glossary of canonical terms.
- [docs/adr/](./docs/adr/) — architecture decisions and rationale.
- [CLAUDE.md](./CLAUDE.md) — agent-facing pointer and TDD working method.
- [CHANGELOG.md](./CHANGELOG.md) — release history.

## Tests

```sh
bun run test          # parallel across workers
bun run test:serial   # one file at a time
bunx tsc --noEmit
```

Tests spawn the CLI via `Bun.spawn` against a tempdir `TASKS_HOME` and assert on stdout, stderr, exit codes, and on-disk state. No git mocking, no assertions on internal modules. The `--timeout 30000` in `bun run test` is deliberate: each test forks the CLI plus several `git` processes, so under heavy parallelism CPU-bound tests would exceed the 5s default. See [CLAUDE.md](./CLAUDE.md) for the working method.

## License

Private.
