# tasks

Single-binary Bun/TypeScript CLI for human + agent task management. Tasks are markdown files with YAML frontmatter, stored in a per-project git repo at `$TASKS_HOME/projects/<encoded-path>/`. Every mutation is a git commit.

## Authoritative docs
- `docs/commands.md` — the command surface, flags, JSON shapes, and error codes. Source of truth for *what* and *how*. `README.md` is the quickstart that points here.
- `CONTEXT.md` — glossary. Use these terms exactly (Task, Store, Column, Dep, Short ID, UUID, Lock, Validator, Transition...).
- `docs/adr/` — decisions and their rationale (git-backed store, status-by-directory, open transitions, flock lock model, path encoding, library choices, etc.).

## Working method (non-negotiable)
- TDD outside-in at the CLI boundary. Tests spawn the binary against a `TASKS_HOME` tempdir; assert on stdout/stderr, exit codes, and on-disk state. No mocking of `git`. No assertions on internal modules.
- One commit per green state. Message names the behavior: `green: <behavior>`, `refactor: <what>`. No squashing.
- Refactors only from green, landing on green.

## Conventions
- Always `bun`, never `npm`.
- Run tests: `bun run test` (parallel across workers, `--timeout 30000`). `bun test` alone runs one file at a time; `bun run test:serial` forces that. The raised timeout is required: every test spawns the CLI + several `git` subprocesses, and under `--parallel` the CPU-heaviest tests would blow the 5s default while contending for cores. Run CLI in dev: `bun run src/cli.ts ...`.
- Use error codes from README's error-envelope list (`STORE_DIRTY`, `CYCLE_DETECTED`, `UNKNOWN_UUID`, ...) verbatim.
- Mutating commands: acquire `flock`, then dirty-tree guard, then validate, write, commit.
- `--json` is opt-in on every read command; never auto-switch on non-TTY.
