# tasks

Single-binary Bun/TypeScript CLI for human + agent task management. Tasks are markdown files with YAML frontmatter, stored in a per-project git repo at `$TASKS_HOME/projects/<encoded-path>/`. Every mutation is a git commit.

## Authoritative docs
- `PRD.md` — full spec (storage, CLI surface, validator, error codes).
- `CONTEXT.md` — glossary. Use these terms exactly (Task, Store, Column, Dep, Short ID, UUID, Lock, Validator, Transition...).
- `docs/adr/` — decisions (open transitions, lock model, path encoding, etc.).
- `MILESTONES.md` — vertical slices and TDD working method.

## Working method (non-negotiable)
- TDD outside-in at the CLI boundary. Tests spawn the binary against a `TASKS_HOME` tempdir; assert on stdout/stderr, exit codes, and on-disk state. No mocking of `git`. No assertions on internal modules.
- One commit per green state. Message names the behavior: `green: <behavior>`, `refactor: <what>`. No squashing.
- Refactors only from green, landing on green.

## Conventions
- Always `bun`, never `npm`.
- Run tests: `bun test`. Run CLI in dev: `bun run src/cli.ts ...`.
- Use error codes from PRD (`STORE_DIRTY`, `CYCLE_DETECTED`, `UNKNOWN_UUID`, ...) verbatim.
- Mutating commands: acquire `flock`, then dirty-tree guard, then validate, write, commit.
- `--json` is opt-in on every read command; never auto-switch on non-TTY.
