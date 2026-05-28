# MILESTONES: `tasks` v1

Implementation broken into vertical slices. Each milestone delivers user-visible behavior end-to-end (storage + CLI + tests), not a horizontal layer. Numbers in brackets reference user stories in [PRD.md](./PRD.md).

## Working method: TDD with atomic commits at every green

Two non-negotiable constraints govern how every milestone is built:

### Constraint 1: TDD, outside-in, at the CLI boundary

Every behavior is driven by a failing CLI E2E test before any production code exists for it. The validator, store, and renderer modules are not designed up front; they emerge from the tests.

### Constraint 2: Atomic commits at every green state

Every time the test suite is green, the working tree is committed before any further change. A green state that is not committed is a bug in the process. This means:

- One commit per red-green cycle, not per feature, not per milestone, not per day.
- Refactors are their own commits, made only from green and landing on green.
- Adding a failing test is itself a commit (the test file goes in red, marked `.skip` or `.todo` if needed to keep the suite green; or the commit explicitly notes "red: <behavior>" and the very next commit is "green: <behavior>"). Choose one convention per repo and stick to it. **Recommendation:** keep the suite green at every commit by landing the failing test and its implementation in a single "green: <behavior>" commit; use a separate "refactor:" commit for any cleanup.
- Commit messages name the behavior, not the file. `green: tasks new rejects empty title`, not `update validator.ts`.
- No squashing across green states at merge time. The per-green history is the audit trail of how the system was built and is preserved on the main branch.

### The loop, per behavior

1. **Write the failing CLI E2E test.** Spawn the (`bun run`) binary against a `TASKS_HOME` tempdir. Assert on stdout/stderr (text and parsed `--json`), exit code, and on-disk state (file layout, frontmatter, `git log`). No mocking of `git`. No assertions on internal modules.
2. **Run it. Confirm it fails for the right reason** (missing command, wrong exit code, missing file). A test that fails for the wrong reason is not a test yet.
3. **Implement the smallest change** that turns it green. No speculative adjacent behavior; the next test will pull it in.
4. **Commit immediately on green.** `green: <one-line behavior description>`. Do not start the next test before committing.
5. **Refactor only from green, landing on green.** Each refactor is a separate commit prefixed `refactor:`. If a refactor breaks tests, revert; do not "fix forward" past a red state.
6. **Repeat.** A milestone is "done" only when every story it claims has a corresponding green commit, and the working tree is clean.

Validator behavior is exercised through the CLI commands that drive it, never directly. If a behavior can't be observed from outside the binary, it isn't worth asserting on, and it shouldn't get its own commit.

## Slicing principle: command-by-command, demoable per slice

Each milestone introduces one observable capability and the smallest infrastructure needed to support it. Cross-cutting concerns (validation, error envelope, color handling) land at the first slice that needs them so later slices don't retrofit prior commits. The early slices are heavier in proportion because foundational contracts (frontmatter, error envelope, lock, dirty-tree guard, required-field + title validation) all need to be true from the first written task.

---

## M1: Capture and inspect (JSON)

**Value:** `tasks new "title"` writes a real task and `tasks show 1 --json` reads it back. The store is a git repo from the first commit. Foundational contracts (frontmatter shape, error envelope, lock, dirty-tree guard, schema validation) are pinned by this slice.

**Stories covered:** 1, 16, 17, 18, 19, 20, 23, 24 (show `--json`), 25, 28, 31 (schema rules — required fields + title constraints), 32 (JSON error envelope), 33, 35 (body stored), 36 (`created_at`).

**Behavior:**
- Path resolver: cwd walks up to nearest `.git`, falls back to literal cwd, encodes under `~/.tasks/projects/` with the `--` doubling rule. `TASKS_HOME` overrides root.
- Auto-init on first mutating command: create dir, `git init`, empty initial commit, stderr notice. All six column dirs created so later slices don't need to create them on the fly.
- `flock` wrapper around mutations; clear actionable error if `flock` missing. Dirty-tree guard runs after lock. Lock contention exercised by parallel `tasks new` test; dirty tree forced via raw `git` in tests until `edit` arrives.
- Frontmatter via `yaml` Document API. UUID v4 from stdlib. Short ID from `meta.yaml` `next_id`, allocated + bumped + committed atomically.
- `tasks new <title>`: title only, no flags. One commit, prefix `task: new #N`.
- `tasks show <id|uuid> --json` only (human renderer waits for M2). Returns full structured task including `body`.
- **Schema validation lives here from the first write.** Required fields (`id`, `uuid`, `title`, `created_at`, `updated_at`) and title constraints (non-empty, single line, ≤200 chars) enforced by the validator. Graph rules (cycles, unknown UUID) wait for M7a.
- **JSON error envelope shape lives here from the first error.** `{ "error": { "code", "message", "details": {} } }`. Codes introduced this slice: `STORE_DIRTY`, `NOT_FOUND`, `MISSING_FIELD`, `INVALID_TITLE`. Later slices add codes; envelope shape never changes.
- E2E harness lands here and is the reference style for everything after.

**Depends on:** nothing.

---

## M2: Human renderer + color handling

**Value:** `tasks show` reads pleasantly in a terminal, and the convention for color is set so every later command inherits it.

**Stories covered:** 13.

**Behavior:**
- Human-facing renderer for `tasks show`: header block (id, uuid, column, flags, timestamps) + body markdown with light ANSI styling.
- Renderer module owns `--no-color` flag handling and `NO_COLOR` env detection. Every later command's rendering goes through this module so the property is true by construction.

**Depends on:** M1.

---

## M3: Flat list

**Value:** see everything that exists.

**Stories covered:** 10, 24 (list `--json`).

**Behavior:**
- `tasks list [--json]`: all six columns, no filters yet.
- Human and JSON renderers both routed through M2's color-aware path.

**Depends on:** M2.

---

## M4: Filters, board, cutoff

**Value:** focus on a slice of the work; see it laid out as kanban.

**Stories covered:** 11, 12, 15, 27 partial (graph readable via `list --json`; edges still empty until M7).

**Behavior:**
- `tasks list --column <name>...` repeatable filter.
- `tasks list --all` and `--since <duration>` overrides.
- `tasks board [--all] [--since] [--json]`: static Ink kanban, fixed widths, ANSI box drawing, per-column truncation.
- 7-day cutoff on `done/` via `updated_at` applies to both `list` and `board` by default.

**Depends on:** M3.

---

## M5: Move

**Value:** advance work through the pipeline.

**Stories covered:** 6, 30.

**Behavior:**
- `tasks mv <id|uuid> <column>` via `git mv`. Same-column is a no-op (no commit, exit 0).
- `updated_at` bumped on the moved task.
- New code: `INVALID_COLUMN` error code added to the envelope enum.

**Depends on:** M1.

---

## M6: Edit and delete

**Value:** correct and remove tasks.

**Stories covered:** 2, 3, 36 (`updated_at` bumped on every touch).

**Behavior:**
- `tasks edit <id|uuid> [--abort]`: `$EDITOR` round-trip, validate on save. On invalid save: reject, keep bad file, non-zero exit, no commit. Exempt from dirty-tree guard. Title change recomputes slug and performs content update + `git mv` in one commit. `--abort` discards pending changes and resets working tree to HEAD.
- `tasks rm <id|uuid>`: deletes the task and commits. No `--force` yet; no dependents possible until M7a, so this slice's rm always succeeds when the task exists.
- `updated_at` discipline applied to every command that touches a task.

**Depends on:** M1. The dirty-tree guard's "natural" test lives here.

---

## M7a: DAG model and rm cascade

**Value:** the store gains real dependencies and the validator gains the rules that protect the graph. `rm --force` becomes meaningful.

**Stories covered:** 3 (rm with cascade), 22 (capability surface), 27 (write graph), 31 (graph rules).

**Behavior:**
- `deps: [uuid...]` frontmatter field with default `[]`.
- Validator gains graph rules: cycle detection over the full DAG, unknown-UUID rejection. Adds `CYCLE_DETECTED` and `UNKNOWN_UUID` to the envelope enum.
- `tasks rm <id|uuid> [--force]`: now refuses with `DEP_EXISTS` if any task lists this UUID in `deps`. `--force` deletes and strips dangling refs from dependents in the same commit, prints affected tasks to stderr. Adds `DEP_EXISTS` to the enum.
- M6's `tasks rm` tests stay green (fixtures have no deps); new tests cover the refuse-and-cascade branches.

**Depends on:** M6.

---

## M7b: Link, unlink, blockers display

**Value:** humans and agents express ordering ergonomically; `show` exposes it.

**Stories covered:** 4, 5, 14, 29.

**Behavior:**
- `tasks link <id|uuid> --depends-on <id|uuid>...` and `tasks unlink ...`: repeatable arg, single commit per invocation.
- `tasks show` extended: renders forward deps as `#id title` and reverse edges (what this task blocks).

**Depends on:** M7a, M2 (renderer for the extended `show`).

---

## M8: Agent collaboration

**Value:** agents read and write safely with structured signals.

**Stories covered:** 8, 9, 21, 26, 34.

**Behavior:**
- `attendance` (`attended` | `unattended`, default `attended`) and `effort` (`low` | `medium` | `high`, default `medium`) frontmatter fields. `tasks new` writes both defaults explicitly to disk. Read commands resolve missing values to the default and always surface the resolved value in `--json`. Validator rejects invalid enum values with `INVALID_ATTENDANCE` / `INVALID_EFFORT`.
- `tasks new --unattended --effort <low|medium|high>`, plus `--edit`, `--body -` from stdin, `--deps` on creation.
- `tasks set <id|uuid> [--title <title>] [--attendance ...] [--effort ...]`: scalar setter; at least one flag required; multiple flags combined into a single commit. `--title` triggers slug recompute + `git mv` in the same commit (same semantics as `edit`'s title-change path).
- `tasks list` gains `--attendance <attended|unattended>` and `--effort <low|medium|high>` filters (single value each).
- `tasks next [--attendance <attended|unattended>] [--unattended] [--json]`: `ready/` + all deps in `done/`. No attendance filter by default; `--unattended` (shorthand for `--attendance unattended`) restricts to safe-for-agent work, replacing the old `agent_ready: true` gate. Oldest `created_at` wins. Adds `NO_READY_TASK` to the enum.
- Acceptance Criteria parser (hand-rolled, fence-aware, case-insensitive). On `--json` reads (`show`, `list`, `board`, `next`): `acceptance_criteria` (string, `""` if absent) exposed alongside `body`. `attendance` and `effort` are always emitted with their resolved value.
- Human renderings: `show` includes `attendance` and `effort` in the header block (full words). `list` and `board` append compact dim-styled glyphs per row (e.g. `○` attended / `●` unattended, `·L` / `·M` / `·H` for effort) so the kanban layout stays tight.

**Depends on:** M7a (deps-complete check), M6 (edit + body plumbing; `tasks set --title` shares slug/rename logic with `edit`), M2 (renderer for `next` and the new fields).

---

## M9: Undo

**Value:** non-destructive recovery from the most recent change without learning git.

**Stories covered:** 7.

**Behavior:**
- `tasks undo`: `git revert --no-edit HEAD` in the store, itself committed. Refuses on initial empty commit. Adds `NOTHING_TO_UNDO` to the enum.

**Depends on:** M1 (commits to revert exist from the first slice).

---

## M10: Ship

**Value:** a binary a user can install.

**Stories covered:** none new — final consistency pass over everything.

**Behavior:**
- Explicit `tasks init` command (rarely needed; documented as the manual escape hatch).
- `bun build --compile` artifact built in CI and smoke-tested against a fresh tempdir.
- README: install steps for `flock` on macOS, `TASKS_HOME` override, error-code reference.
- Final symmetry check: every command supports `--json` where the PRD says it should, every command honors `--no-color`/`NO_COLOR`, every error path emits the envelope shape.

**Depends on:** everything prior.

---

## Dependency graph

```
M1 ──┬── M2 ── M3 ── M4
     ├── M5
     ├── M6 ── M7a ── M7b
     │           └─── M8 ── M9 ── M10
     └── M9 (also reachable directly from M1)
```

Parallelizable after M1:
- M2→M3→M4 (read-side chain).
- M5 (move) can ship anywhere after M1.
- M6→M7a→M7b/M8 (write-side chain).
- M9 (undo) needs only M1.

M10 lands last so the audit covers the full surface.

## Story coverage matrix

| Story | Milestone |
|------:|-----------|
| 1 | M1 |
| 2 | M6 |
| 3 | M6 (basic), M7a (cascade + `--force`) |
| 4 | M7b |
| 5 | M7b |
| 6 | M5 |
| 7 | M9 |
| 8 | M8 |
| 9 | M8 |
| 10 | M3 |
| 11 | M4 |
| 12 | M4 |
| 13 | M2 |
| 14 | M7b |
| 15 | M4 |
| 16 | M1 |
| 17 | M1 |
| 18 | M1 |
| 19 | M1 |
| 20 | M1 |
| 21 | M8 (capability surface; orchestration deferred) |
| 22 | M7a (capability surface; agent loop deferred) |
| 23 | M1 |
| 24 | M1 (`show`), M3 (`list`), M4 (`board`) |
| 25 | M1 |
| 26 | M8 |
| 27 | M4 (read graph via `list --json`), M7a (write graph) |
| 28 | M1 |
| 29 | M7b |
| 30 | M5 |
| 31 | M1 (schema rules), M7a (graph rules) |
| 32 | M1 (envelope shape + initial codes), M5/M7a/M8/M9 (additional codes) |
| 33 | M1 |
| 34 | M8 |
| 35 | M1 (stored), M8 (exposed in `--json` alongside parsed `acceptance_criteria`) |
| 36 | M1 (`created_at`), M5/M6/M7a (`updated_at` on every touch) |
