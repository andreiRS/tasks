# PRD: `tasks` — CLI Task Manager for Human + Agent Collaboration

## Problem Statement

A developer working closely with Claude Code agents needs a way to capture, track, and hand off work across humans and agents. Existing tools force a bad trade:

- **GitHub Issues / Linear / Jira**: cloud-hosted, web-first, heavyweight, not designed for a CLI-native workflow. Agents can use the APIs but the round-trip and UX cost is high.
- **Taskwarrior**: mature CLI but optimized for a single human operator; agent-collaboration semantics (typed states, structured handoffs) are absent.
- **dstask**: closest in storage model (per-project git-backed markdown), but `Dependencies` is a stub the maintainer never finished, there is no kanban view, and there is no notion of which tasks are safe for an agent to pick up unattended.

The developer wants to capture tasks in seconds, express dependencies between them, see a kanban view in the terminal, and let agents both read and write the same task store without corrupting it.

## Solution

A single-binary CLI called `tasks` that stores per-project task data in a git-backed directory under `~/.tasks/projects/<encoded-project-root>/`, mirroring Claude Code's convention for locating per-project state.

Tasks are markdown files with YAML frontmatter. Status is encoded by the enclosing directory (`backlog/`, `ready/`, `doing/`, `blocked/`, `review/`, `done/`). Dependencies form a flat DAG referenced by stable UUIDs. The CLI is the only sanctioned write path: it validates writes (cycles, unknown references, required fields) so that agents and humans cannot easily corrupt the store. Read commands offer a `--json` flag for agent consumption.

Humans get a fast `tasks new`, `tasks list`, and `tasks board`. Agents get structured JSON, deterministic exit codes, and a `tasks next` command that surfaces ready, unblocked work.

## User Stories

### Human authoring and review

1. As a developer, I want to create a task from the CLI so that I can capture work without leaving my terminal.
2. As a developer, I want to edit a task's spec in my `$EDITOR` so that I can refine acceptance criteria as I learn more.
3. As a developer, I want to delete a task so that I can drop work that is no longer relevant.
4. As a developer, I want to link two tasks as dependent so that I can express ordering constraints.
5. As a developer, I want to unlink a dependency so that I can correct mistakes.
6. As a developer, I want to move a task between columns with a single command so that transitions are cheap.
7. As a developer, I want to undo the most recent change so that I can recover from mistakes without learning git internals.
8. As a developer, I want to mark a task as `attended` or `unattended` so that I can control whether an agent may pick it up.
9. As a developer or agent, I want to record a task's `effort` (low / medium / high) so that the right cognitive or model resource can be chosen when the task is picked up.

### Human reading and navigation

10. As a developer, I want a flat list of all tasks so that I can scan everything quickly.
11. As a developer, I want a kanban view so that I can see work-in-progress at a glance.
12. As a developer, I want to filter the list by column so that I can focus on one slice of work.
13. As a developer, I want to see a task's full content (spec, deps, body) so that I have the context I need.
14. As a developer, I want to see what is blocking a task and what it is blocking so that I can reason about clearing dependencies.
15. As a developer, I want completed tasks to remain visible (in `done/`) so that I have a record of past work.

### Identifiers and ergonomics

16. As a developer, I want short numeric IDs to type in commands so that I am not pasting UUIDs all day.
17. As a developer, I want stable UUIDs under the hood so that cross-references survive any future changes to display IDs.
18. As a developer, I want the tool to find the right task store automatically based on `pwd` so that I never manage configuration.
19. As a developer, I want each project's tasks isolated by working directory so that contexts never mix.
20. As a developer, I want the same column vocabulary across projects so that my muscle memory transfers.

### Collaborating with agents

21. As a developer, I want to ask Claude in an interview session to create the initial backlog so that I can offload setup.
22. As a developer, I want to ask an agent to expand a task into a set of dependent tasks so that breakdown is conversational.
23. As a developer, I want to see in git history exactly which changes an agent made so that I can review or revert.

### Agent reading

24. As an agent, I want to read tasks as structured JSON so that I can parse without scraping human-readable text.
25. As an agent, I want to read a single task's full content (frontmatter + body) so that I have everything needed to execute it.
26. As an agent, I want to query the next ready, unblocked, agent-ready task so that I know what to pick up.
27. As an agent, I want to query the dependency graph so that I can plan multi-step work.
27a. As an agent, I want a single-call whole-Store dump (`tasks export`) so that I can learn the state of the project in one tool call instead of `list` + N × `show`.
27b. As an agent, I want a compact Store digest (`tasks summary`) at session start so that I can orient myself without pulling every Task body into context.

### Agent writing

28. As an agent, I want to create new tasks via the CLI so that my writes are validated and committed.
29. As an agent, I want to link dependencies between tasks via the CLI so that I can express the work breakdown.
30. As an agent, I want to update a task's column so that I can record progress as I move through work.
31. As an agent, I want the CLI to reject invalid writes (cycles, unknown UUIDs, missing required fields) so that I cannot corrupt the store.
32. As an agent, I want non-zero exit codes and JSON-formatted errors so that I can detect and handle failures programmatically.
33. As an agent, I want every write recorded as a git commit so that a human can audit my activity.

### Spec and acceptance

34. As either a human or agent, I want a task to carry explicit acceptance criteria so that "done" is unambiguous.
35. As either a human or agent, I want a free-form markdown body on a task so that context and notes have a home.
36. As either a human or agent, I want a task's `created_at` and `updated_at` recorded automatically so that timestamps are reliable.

## Implementation Decisions

### Language and distribution

- Implemented in TypeScript on Bun (developed against Bun `1.3.14`+). Built with `bun build --compile` to a single native executable; v1 ships as a GitHub release. No npm publish in v1 (see Deferred).
- Git is invoked by shelling out to the system `git` binary via `Bun.spawn`. No git library dependency.

### Libraries and tooling

The dependency surface is deliberately small. Every choice below was confirmed against the latest published version at the time of writing.

- **CLI argument parsing**: stdlib `util.parseArgs` (zero deps). Subcommand dispatch is hand-rolled on top of it. Chosen over Commander/Citty to keep the compiled binary lean.
- **YAML frontmatter**: [`yaml`](https://www.npmjs.com/package/yaml) (eemeli/yaml) `^2.9.0`. Used via the `Document` API so frontmatter rewrites preserve field ordering and quoting style across edits.
- **UUIDs**: stdlib `crypto.randomUUID()` (v4). No `uuid` npm dep.
- **Git invocation**: stdlib `Bun.spawn` shelling out to system `git`.
- **Rendering (`list`, `board`, `show`, `next`)**: [`ink`](https://www.npmjs.com/package/ink) `^7.0.4`. Rendered as static output (single render + unmount, no interactive loop) so the PRD's "static print" constraint for `board` still holds. Ink is chosen over picocolors + hand-rolled layout to leave room for richer renderings in future versions without rewriting the render layer. ANSI styling honors `NO_COLOR` via Ink/chalk; `--no-color` is wired explicitly on every command.
- **Tests**: stdlib `bun:test`. E2E style: tests spawn the compiled (or `bun run`-driven) binary against a `TASKS_HOME` tempdir and assert on stdout/stderr, exit codes, and on-disk state. No mocking of `git`.
- **Locking**: shell out to `/usr/bin/flock` via `Bun.spawn` (see Concurrency).

**External binary dependencies**: `git` (assumed present on any developer machine) and `flock`. On macOS, `flock(1)` is not bundled with the OS and must be installed (e.g. `brew install flock`). The README and install instructions must call this out, and `tasks` itself prints a clear actionable error if `flock` is missing on `$PATH`.

### Repository scaffolding

- **Package name**: `tasks`. The binary-name collision risk noted in Further Notes still applies and must be verified before release.
- **License**: MIT.
- **`engines` field**: omitted. The project is Bun-only and ships a compiled binary; declaring a Node version range would be misleading.
- **TypeScript types**: `@types/bun` (the current, actively maintained package; `bun-types` is the legacy alias).
- **`tsconfig.json` baseline**: `"module": "esnext"`, `"moduleResolution": "bundler"`, `"target": "esnext"`, `"strict": true`, `"types": ["bun"]`.

### Acceptance Criteria parser

Implemented as a hand-rolled line scanner, not via a markdown AST library. The PRD's parsing rules (case-insensitive `## acceptance criteria`, terminate at the next `^##+ ` heading or EOF, ignore heading-like lines inside ```` ``` ```` or `~~~` fenced code blocks) fit cleanly in a small state machine tracking a single "inside fence" boolean. A markdown library like `remark` is rejected because it would pull a large AST toolchain into the compiled binary for a job that does not benefit from full markdown parsing, and because keeping the parser literal makes the documented rules easier to honor exactly.

### Storage

- One git repo per project, located at `~/.tasks/projects/<encoded-project-root>/`.
- **Project root resolution**: the tool walks up from `pwd` to the nearest `.git` directory and uses that as the project root. If no `.git` is found, it falls back to literal `pwd`. The resolved absolute path is then encoded.
- **Path encoding**: literal `-` is doubled to `--`, then `/` is replaced with `-`. This is reversible and avoids the collision where `/Users/a-b/c` and `/Users/a/b/c` would otherwise both encode to `-Users-a-b-c`. Example: `/Users/andrei/Projects/tasks` → `-Users-andrei-Projects-tasks`; `/Users/a-b/c` → `-Users-a--b-c`.
- `~/.tasks/` can be overridden by the `TASKS_HOME` environment variable. Used primarily for hermetic testing.
- The store is auto-initialized on the first mutating command if it does not yet exist: directory is created, `git init` runs, an empty initial commit is made, and a one-line notice is printed to stderr (`tasks: initialized store at …`). Read commands do **not** auto-initialize; they return empty results with exit 0 when no store exists. An explicit `tasks init` is available but rarely needed.
- One markdown file per task: YAML frontmatter on top, free-form markdown body below.
- **Filename**: `<id>-<slug>.md` inside the column directory. The slug is derived from the title (lowercased, non-alphanumerics → `-`, collapsed, trimmed). On title change, the file is renamed via `git mv` to match the new slug. The UUID is the stable identifier; slug/filename is a display convenience only.
- Status is encoded by the enclosing directory: `backlog/`, `ready/`, `doing/`, `blocked/`, `review/`, `done/`. Moving a task between columns is a `git mv`. A seventh sibling directory `archive/` holds tasks that have been retired via `tasks archive`; it is **not** a Column (Transitions never target it). See ADR-0010.
- Every mutating command produces a git commit. Commit messages are prefixed by the command, e.g. `task: new #42 — add OAuth flow`. Git history is the audit log. Commits use the user's global git identity (no special actor tagging in v1; see Deferred).
- **Dirty working tree**: at the start of every command, if the store's working tree is dirty (uncommitted changes), the command refuses with a `STORE_DIRTY` error and instructions to run `tasks edit --abort` (or `tasks edit <id>` to fix in place). Exceptions: `tasks edit` and `tasks edit --abort` are allowed when the tree is dirty so they can serve as the recovery path after a failed save.
- **Concurrency / locking**: every mutating command takes an exclusive `flock` on `~/.tasks/projects/<encoded-root>/.tasks-lock` for its full duration. The lock guards `max(id)+1` allocation, validation, file writes, and the commit as a single critical section. Read commands do not take the lock. The dirty-tree guard runs *after* the lock is acquired so concurrent invocations serialize cleanly instead of racing the check.
- **Timestamps**: every mutating command (`new`, `edit`, `mv`, `link`, `unlink`, `rm` of dependents) bumps `updated_at` on every task it touches. This keeps the `done/` cutoff in `list`/`board` meaningful — a task moved to `done` today is visible regardless of when it was created.

### Task model

- Flat. There are no subtasks. A complex unit of work is multiple tasks linked by dependencies.
- Dependencies are unidirectional (`A depends on B` means `B` blocks `A`). The collection of dependencies across all tasks forms a DAG.
- A dep is considered **complete** only when the depended-on task is in `done/`. `review/` does not count as complete for blocking purposes.

### Identifiers

- Each task has two identifiers:
  - A **short numeric ID**, scoped per-project, monotonically increasing and **never reused**. Allocated by reading and incrementing a counter in `~/.tasks/projects/<encoded-root>/meta.yaml` (created at store init with `next_id: 1`). The counter is updated and committed in the same commit as the new task. Deleting a task does not roll the counter back.
  - A **UUID** (v4), globally stable, used for all internal references (deps, future cross-system integrations).
- Dependencies always reference UUIDs. Short IDs are a display/input convenience only.
- **ID inputs at the CLI**: anywhere a task ID is accepted (`mv`, `show`, `rm`, `link`, `unlink`, `--deps`), the tool accepts either a short ID (positive integer) or a UUID, auto-detected by shape. Humans pass short IDs; agents pass UUIDs for stability.

### Frontmatter schema

```yaml
id: 42
uuid: 7f3a9c2e-...
title: add OAuth flow
deps: ["uuid-a", "uuid-b"]
attendance: attended
effort: medium
created_at: 2026-05-27T10:14:00Z
updated_at: 2026-05-27T10:14:00Z
```

- **Required** fields (validator rejects writes missing them): `id`, `uuid`, `title`, `created_at`, `updated_at`.
- **Optional** fields with defaults: `deps` (default `[]`), `attendance` (default `attended`), `effort` (default `medium`).
- `attendance` accepts exactly `attended` or `unattended`. `effort` accepts exactly `low`, `medium`, or `high`. Any other value is rejected with `INVALID_ATTENDANCE` or `INVALID_EFFORT`.
- `tasks new` writes the default values for `attendance` and `effort` explicitly to disk so frontmatter is self-describing when opened in `$EDITOR`. When an older file omits either field, read commands resolve to the default and always surface the resolved value in `--json` (consumers never see `null` or an absent key).
- `attendance` is a pure pickup-gate: `unattended` means an agent may pick this task up; `attended` excludes it from agent pickup. `effort` is pure metadata in v1: it is stored, surfaced, and filterable, but the CLI does not act on it (no automatic model selection, no ordering bias). Orchestration loops outside `tasks` are free to interpret it.
- `title` constraints: non-empty, single line, max 200 characters.
- **Acceptance criteria** live in the markdown body as a conventional `## Acceptance Criteria` section, not in frontmatter. The body remains free-form markdown otherwise. When `--json` is set on read commands, the tool parses the `## Acceptance Criteria` section out of the body and exposes it as an `acceptance_criteria` string field (empty string if the section is absent). The body itself is also returned as `body`.
- **Acceptance Criteria parsing rules** (exact, for consistency across implementations and agent consumers):
  - Heading match is **case-insensitive** on the literal string `acceptance criteria`, preceded by exactly `## ` at the start of a line.
  - The section extends from the line after the heading to the line **before the next `##` heading of any level** (i.e. any line matching `^##+ `) or end-of-file, whichever comes first.
  - Lines inside fenced code blocks (delimited by ```` ``` ```` or `~~~`) are ignored for heading matching, so a fake heading inside a code fence does not start or end the section.
  - The extracted value is trimmed of leading/trailing blank lines; internal formatting is preserved verbatim.

### Modules

- **Store**: reads and writes markdown files, manages the per-project git repo, executes commits and reverts.
- **Validator**: enforces invariants on every write — cycle detection over the dependency graph, rejection of unknown UUID references, required-field presence, title constraints. Runs inside every mutating command, never bypassable from the CLI.
- **Path resolver**: walks up from cwd to the nearest `.git`, falls back to cwd, then encodes to the store directory.
- **CLI**: argument parsing and the user-facing command surface (below). All mutations pass through the validator.
- **Renderers**: human-readable and JSON renderers for `list`, `board`, `show`, `next`.

### CLI surface (v1)

- `tasks init` — explicit initializer (rarely needed; `tasks new` auto-initializes).
- `tasks new <title> [--deps <id|uuid>...] [--unattended] [--effort <low|medium|high>] [--edit] [--body -]` — create a task in `backlog/`. By default, title-only and no editor; `attendance` defaults to `attended` and `effort` to `medium`. `--unattended` sets `attendance: unattended` at creation. `--edit` opens `$EDITOR` for the body after creation; `--body -` reads the body from stdin. Validator runs before commit.
- `tasks set <id|uuid> [--title <title>] [--attendance <attended|unattended>] [--effort <low|medium|high>]` — scalar setter for the three fields a single command can change cleanly. At least one flag is required; passing zero flags is an error. Multiple flags in one invocation are applied and committed together. `--title` recomputes the slug and performs the content update plus `git mv` in the same commit, matching the title-change semantics of `tasks edit`. `--attendance` and `--effort` validate the enum value (`INVALID_ATTENDANCE` / `INVALID_EFFORT` on a bad value). Deps are mutated via `link`/`unlink`, not `set`.
- `tasks show <id|uuid> [--json]` — display a task. Human rendering: header block (id, uuid, column, `deps:`, `blocks:`, `attendance`, `effort`, timestamps) followed by the body markdown with light ANSI styling (bold headings, dim metadata). `list` and `board` render attendance and effort as compact dim-styled glyphs per row rather than full words so the kanban layout stays tight. JSON returns the full structured task.
  - **`deps:` rendering**: each dependency is rendered as `#<shortId> <title>`, one per line. If a dep UUID cannot be resolved to any task in the store (orphan or corruption), it renders as `<unknown> <uuid>` rather than erroring; `show` exits 0 regardless.
  - **`blocks:` block**: after `deps:`, a `blocks:` block lists every task whose `deps` includes this task, formatted as `#<shortId> <title>`, one per line, sorted ascending by short id. If nothing depends on this task the block is omitted entirely. A done dependant still appears; column state does not filter the reverse list.
  - **`--json`**: the existing JSON schema for `show` is unchanged in v1.
- `tasks edit <id|uuid> [--abort]` — open the file in `$EDITOR`; validate on save. On invalid save, the command rejects the save, keeps the bad file on disk, prints an error, and exits non-zero — no commit is made. The user can re-run `tasks edit <id>` to fix in place (this command is exempt from the dirty-tree check), or `tasks edit --abort` to discard all pending changes in the store and restore the working tree to HEAD. If the user changes the `title` in frontmatter, `edit` recomputes the slug and performs the content update + `git mv` in the same commit, so the filename always reflects the current title.
- `tasks mv <id|uuid> <column>` — move a task between columns via `git mv`. Moving to the current column is a no-op (no commit, exit 0).
- `tasks link <id|uuid> --depends-on <id|uuid>...` — add edges; `--depends-on` is repeatable; a single invocation produces a single commit covering all added edges.
- `tasks unlink <id|uuid> --depends-on <id|uuid>...` — remove edges; same multi-arg and single-commit semantics.
- `tasks rm <id|uuid> [--force]` — delete a task. If any other task lists this task in its `deps`, the command refuses unless `--force` is given. With `--force`, the task is deleted and dangling UUID references are stripped from all dependents in the same commit; the command prints the affected tasks to stderr before committing (e.g. `tasks: rm #42 — stripped dep from #17, #19, #23`) so the cascade is never invisible.
- `tasks list [--column <name>...] [--attendance <attended|unattended>] [--effort <low|medium|high>] [--all] [--since <duration>] [--json]` — flat list. `--column` is repeatable; `--attendance` and `--effort` take a single value each (omit the flag for no filter on that axis). By default, includes all six columns but hides `done/` tasks whose `updated_at` is older than 7 days. `--all` shows everything regardless of age. `--since 30d` overrides the cutoff window. Rows with one or more Unresolved Blockers append a marker at the far right (after the `O·M` column): `[blocked by #N,#M]` — short ids, comma-separated, no spaces, ascending order. Rows without unresolved blockers have no marker. `--json` adds a `blockedBy: [shortId, ...]` field to each row (unresolved blockers only; empty array when none).
- `tasks board [--all] [--since <duration>] [--json]` — kanban view. Side-by-side columns with fixed widths, ANSI box-drawing, titles truncated per column. Same default 7-day cutoff for `done/`; same `--all` and `--since` overrides. Static print, no TUI. Rows carry the same `[blocked by #N,#M]` marker and `blockedBy` JSON field as `list`, using the same row-rendering helper and identical rules.
- `tasks next [--attendance <attended|unattended>] [--unattended] [--json]` — show the next task that is in `ready/` and has all deps complete (in `done/`). No attendance filter by default, so a human running `tasks next` sees the oldest ready, unblocked task regardless of who should pick it up. Agents pass `--unattended` (shorthand for `--attendance unattended`) to restrict to safe-for-agent work; this is the direct replacement of the old `agent_ready: true` gate. Among multiple candidates, returns the one with the oldest `created_at`. Exits non-zero with `NO_READY_TASK` if no candidate exists.
- `tasks undo` — `git revert --no-edit HEAD` in the store, then commit. The revert itself is a new commit; undo is non-destructive and itself undoable. If HEAD is the initial empty commit (nothing to undo), the command refuses with a `NOTHING_TO_UNDO` error and exits non-zero.
- `tasks archive [<id|uuid>] [--before <duration>] [--json]` — retire `done/` tasks into the sibling `archive/` directory. With no args, archives every task currently in `done/`. With `--before <duration>`, archives only `done/` tasks whose `updated_at` is older than the cutoff. With a single `<id|uuid>`, archives just that task (which must be in `done/`; archiving from any other column is rejected with `INVALID_COLUMN`). All three forms produce a single commit covering every moved task. The command takes the Lock and honors the dirty-tree guard like any other mutating command. Archived tasks still count as Complete for blocking purposes; see ADR-0010.
- `tasks export --json [--include-archived] [--columns <col,col,...>]` — whole-Store JSON dump for agents. Returns every live Task (frontmatter + body + parsed `acceptance_criteria`), a `reverse_deps` index, the Store HEAD commit SHA, and a `schema_version`. Tasks are grouped by Column in fixed order and sorted by `created_at` ascending within each Column for deterministic diffs. Archived Tasks are excluded by default; any Archived Task referenced as a Dep by a live Task is emitted as an Archive Stub (`{ id, uuid, title, column: "archive", complete: true }`) so the Dep graph is never dangling. `--include-archived` emits the full archive as a seventh group with bodies (stubs are not also emitted). `--columns` restricts the live set; stubs still appear for archived deps of in-scope Tasks. `--json` is required. Read command: does not take the Lock, does not Auto-init, does not run the Validator. See ADR-0011.
- `tasks summary --json [--recent <N>] [--stale <duration>]` — compact Store digest. Returns `counts` (per-Column plus `archive`), `recent` (the last 10 live Tasks by `updated_at`, minimal stub per entry), and `stale` (live Tasks in `doing`/`blocked`/`review` whose `updated_at` is older than 14 days, same minimal stub shape, oldest first). Separate envelope from `export`: no `tasks` array. `--recent N` overrides the 10-task default; `--stale <duration>` overrides the 14-day threshold. `--json` is required. Read command.
- `tasks doctor [--clean] [--json]` — store diagnostics and recovery. Without flags, prints the absolute store path, `git status --short` of the store, and the count of outstanding `doctor` stashes; always exits 0. With `--clean`, runs `git stash push --include-untracked -m "doctor <iso-ts>"` inside the store so subsequent mutating commands no longer hit `STORE_DIRTY`; on a clean tree it is a no-op and prints `store already clean`. On a successful stash it prints the new stash ref and the store path so the user can recover the contents with stock `git stash pop` if desired. `doctor` does not take the flock, does not validate schema, and never deletes files; recovery is non-destructive by construction. See ADR-0009.

### Output

- Human-readable rendering by default; `--json` flag on every read command. `--json` must be explicit — non-TTY stdout does **not** auto-switch.
- **Color**: ANSI styling is applied when stdout is a TTY. Honors `NO_COLOR=1` and a `--no-color` flag on all commands.
- **Errors**: written to stderr with non-zero exit codes. When the invoking command was given `--json`, the error body on stderr is JSON of the form:
  ```json
  { "error": { "code": "CYCLE_DETECTED", "message": "...", "details": { ... } } }
  ```
  `code` is a stable machine-readable enum. Defined codes for v1 include: `STORE_DIRTY`, `NOT_FOUND`, `CYCLE_DETECTED`, `UNKNOWN_UUID`, `MISSING_FIELD`, `INVALID_TITLE`, `INVALID_COLUMN`, `INVALID_ATTENDANCE`, `INVALID_EFFORT`, `DEP_EXISTS` (rm without `--force`), `NO_READY_TASK`, `NOTHING_TO_UNDO`. Without `--json`, errors are plain text on stderr.

### Transitions and column gating

- The CLI does **not** enforce who can move what, or whether a target column is "legal" given the task's deps. Open transitions; rely on git history as the audit log. (Accepted risk: an agent can move a dep-blocked task into `doing`. The dependency graph remains intact; the column state can temporarily be inconsistent with deps.)
- The validator still rejects writes that would corrupt the DAG itself (cycles, unknown UUID references) regardless of who is calling.

### Concurrency

- Concurrent human + agent invocations are explicitly supported via an exclusive `flock` on `~/.tasks/projects/<encoded-root>/.tasks-lock`, held for the duration of any mutating command. The lock makes ID allocation, validation, file writes, and the git commit a single critical section, so two simultaneous `tasks new` invocations serialize cleanly instead of colliding on the same id or producing interleaved partial state. Read commands are lock-free. The dirty-tree guard runs after the lock is acquired.
- The lock is acquired by shelling out to the system `flock(1)` binary via `Bun.spawn`. `flock` is a required external dependency; on macOS it must be installed manually (e.g. `brew install flock`). When `flock` is missing from `$PATH`, mutating commands fail fast with a clear, actionable error pointing the user at the install step.

## Testing Decisions

### What makes a good test

- Tests exercise the CLI binary end-to-end and assert on three observable surfaces: stdout/stderr text and JSON, process exit codes, and the on-disk state of the task store (file layout, frontmatter, git log).
- Tests do not assert on internal module structure. The validator is exercised through the CLI commands that drive it. If a behavior cannot be observed from outside the binary, it is not a behavior worth asserting on.
- Each test runs in a temporary directory pointed at by `TASKS_HOME` so the store is hermetic and parallel-safe. Tests shell out to the real `git` binary; no git mocking.
- `--json` output is parsed and asserted as structured data. No string matching against human-readable rendering.

### Modules tested

- Full CLI surface end-to-end: `new`, `list`, `board`, `show`, `mv`, `link`, `unlink`, `rm`, `next`, `undo`, `edit`, `init`.
- Validator behavior surfaced through CLI failures: dep cycles rejected, unknown UUID references rejected, missing required fields rejected, title constraints enforced.
- Path resolver: cwd → project-root walk-up → store directory mapping, including paths with spaces and unusual characters, and the no-`.git` fallback to literal cwd.
- Git integration: one commit per mutating command, `tasks undo` reverts the last commit, the working tree matches the file state after every successful command, dirty-tree guard refuses subsequent commands.
- Done-cutoff filtering: 7-day default in `list`/`board`, `--all` and `--since` overrides.

### Prior art

- Greenfield. The first round of CLI E2E tests becomes the reference style for everything that follows.

## Out of Scope (v1)

These are explicitly excluded from v1 and not planned for the immediately following milestones:

- Multi-user collaboration, server-side sync, or any concept of remotes beyond `git push/pull` if a human chooses to use them.
- Subtasks. The model is flat: tasks with dependencies, nothing else.
- Configurable column sets per project. The six columns are fixed in v1.
- A TUI. `tasks board` is a static print.
- Auto-dispatching tasks to Claude Code sub-agents. The `attendance` field signals eligibility; the orchestration loop is a separate concern.
- An agent-driven `tasks breakdown` command that splits a task into linked children.
- Enforced routing semantics for `attendance: unattended`. In v1 it is a plain enum value with no automated dispatch.
- Cross-project dependencies. Each project is isolated.
- Time tracking, due dates, priorities, recurring tasks, urgency scoring.
- Encryption at rest.

## Deferred (revisit before v2)

These were considered during design and consciously deferred. Each has a documented v1 fallback and a clear trigger for revisiting.

- **Versioning and distribution.** Pre-1.0 the project ships GitHub releases (tag-driven) with prebuilt macOS/Linux binaries; see `CHANGELOG.md` and `.github/workflows/release.yml`. npm distribution is deferred — revisit if users ask for `bunx tasks` or platform-coverage gaps emerge.
- **Auto-JSON output on non-TTY stdout** and a `TASKS_JSON` env var. v1 requires explicit `--json`. Revisit if agent ergonomics suffer.
- **Agent-vs-human attribution** (e.g. `TASKS_ACTOR` env var, `Co-Authored-By` trailers). v1 inherits the user's git identity for all commits. Revisit when there's a real need to audit agent activity distinctly from human activity.
- **Adaptive board layout** (auto-stack on narrow terminals). v1 is fixed-width side-by-side; user can pipe through `less -S`. Revisit if narrow-terminal use becomes common.
- **Rich markdown rendering in `show`.** v1 uses light ANSI styling only. Revisit if task bodies grow large enough that prose readability matters.
- **`.tasks` marker file for explicit project-root pinning.** v1 walks up to `.git` only. Revisit if users hit the no-`.git` fallback in awkward ways.
- **Per-project config file** (e.g. custom `done` cutoff, custom column set). v1 uses fixed defaults and per-invocation flags. Revisit if multiple projects need durably different settings.
- **Hard transition gating** (rejecting `mv ready` when deps incomplete). v1 leaves transitions open; the validator only protects the DAG. Revisit if open transitions cause observable problems in practice.
- **Whether `tasks next` should hint at blocked tasks** instead of hard-filtering. v1 hard-filters. Revisit if agents would benefit from visibility into near-ready work.
- **Configurable `done` cutoff window.** v1 fixes the default at 7 days with `--all` and `--since <duration>` as overrides. Revisit alongside the per-project config-file question.

## Further Notes

- The binary name `tasks` may collide with other tools on a developer's `$PATH`. Verify before release; consider a fallback name if needed.
- The Claude Code path-encoding scheme is the *contract* for store location, not an imported dependency. If Claude Code changes its encoding internally, this tool stays compatible by spec rather than by code coupling.
- The "open transitions" decision is deliberate. The cost of strict enforcement (every agent move requires a dep check) outweighed its benefit at this stage; git history is the reviewable record.
