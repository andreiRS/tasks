# Review Remediation: Correctness, Error Contract, and Reuse

## Problem

A three-lens deep review (correctness, security/robustness, architecture)
confirmed 20 distinct defects, each reproduced end-to-end against the real
binary by an independent adversarial verifier. The unifying theme: **the
implementation breaks invariants its own ADRs and README already promise.**

- **Concurrency — mutating work escapes the lock.** ADR-0013 says the flock
  makes id-allocation, validation, writes, and the commit "a single critical
  section" and that the dirty-tree guard "runs after the lock." It doesn't.
  `createTask` is the only mutation that omits `requireClean`, so `new`'s dirty
  check (`src/commands/new.ts:70-73`) runs *before* the flock; a racing `new`
  sees the first process's uncommitted file as dirty and aborts with
  `STORE_DIRTY`, silently dropping the task (10 concurrent → 6-9 created). And
  the preamble's `ensureStore` + dirty check (`src/cli/preflight.ts:38-44`) run
  their own `git add`/`commit`/`status` outside the lock, racing another
  process on `.git/index.lock`; the loser gets `GIT_ERROR` and leaves an
  orphaned, uncommitted `backlog/*.md`, breaking "every mutation is a commit."

- **Archive blind spot in the dep graph.** ADR-0010 says archived tasks "still
  count as Complete for blocking purposes" and ADR-0011 that the graph is
  "never dangling." But `validateGraph` (`src/validation.ts:103-117`) and the
  resolver maps in `editTask`/`linkTask`/`unlinkTask` only see live tasks
  (`findAllTasks` never scans `archive/`). Archiving a depended-on task then
  permanently bricks `link`/`unlink`/`edit` on its dependents with
  `UNKNOWN_UUID`, with no in-tool recovery. `removeTask --force` has the mirror
  gap: it strips deps only from live dependents, leaving archived ones dangling.

- **Short ID allocation trusts drift.** ADR-0006 says Short IDs are
  "monotonically increasing... never reused." `createTask`
  (`src/store.ts:88-102`) reads `next_id` from `meta.yaml` verbatim with no
  floor against the real max. Any drift (bad merge, partial restore, manual
  edit) yields a duplicate-id file; `findTask` returns the first match, so
  `show`/`mv`/`set`/`rm`/`link` silently operate on the wrong task. `doctor`
  detects none of it.

- **Error-envelope contract is partial.** The README promises every failure is
  a stable `{error:{code,message,details}}` envelope, machine-parseable under
  `--json`. A single malformed-frontmatter task file crashes nearly every
  command (`list`/`board`/`show`/`next`/`mv`/`set`/`rm`/`summary`) with a raw
  `YAMLParseError` stack trace and no envelope, even under `--json`
  (`src/task-file.ts:31,175,236`) — a store-wide DoS writable by any human or
  agent. There is no top-level error boundary (`src/cli.ts:65`), so any
  non-`TasksError` (corrupt/transient git) escapes the same way and leaks
  absolute paths. And `list`/`export`/`summary` emit undocumented codes
  (`UNKNOWN_COLUMN`, `INVALID_ARG`) that contradict README:99/208, which
  documents `INVALID_COLUMN` for the same failure.

- **Reuse drift.** Logic that defines cross-command contracts is duplicated and
  will diverge: HEAD-sha lookup is triplicated (`export.ts`/`summary.ts`
  reimplement `gitCapture`), the `deps_in`/`deps_out` projection is copy-pasted
  between `show.ts` and `next.ts`, `new` reinlines the mutating preamble instead
  of `mutatingPreamble`, the effort/attendance enums are redeclared in 3-4
  command files, and the editor-runner spawn is duplicated across `new`/`edit`.

**Confidence:** data-backed
**Sources:** three-lens deep-review workflow (25 agents); every finding
reproduced against the real CLI by an independent verifier; file:line cited
throughout this spec.

## Solution

Bring the implementation in line with the invariants the ADRs and README
already assert, then collapse the duplications the review surfaced. No ADR is
overturned by this work; we conform to ADR-0003/0006/0010/0011/0013.

1. **Make the flock the sole critical section.** Add `requireClean: true` to
   `createTask`'s transaction and delete `new`'s pre-lock dirty check. Move
   `ensureStore` and the dirty-tree guard inside the lock so all git index
   operations serialize, as ADR-0013 already describes. This collapses both
   concurrency failures into the documented model.

2. **Teach the dep graph about archive.** Pass `live ∪ archived` to
   `validateGraph` and into the `link`/`unlink`/`edit` resolver maps so archived
   deps resolve; have `removeTask --force` also rewrite archived dependents in
   the same commit. Honors ADR-0010/0011.

3. **Floor Short ID allocation.** Allocate `next_id = max(metaNextId,
   maxExistingId(live ∪ archived) + 1)` with a pre-write uniqueness check, and
   have `doctor` report any pre-existing duplicate ids.

4. **Make the error envelope total.** Wrap every on-disk `yamlParse`/
   `parseDocument` in try/catch (skip-or-surface as a structured error, as
   `validateEnums` already does); add a top-level try/catch in `cli.ts` that
   converts any non-`TasksError` into a sanitized `INTERNAL_ERROR` envelope and
   stop re-throwing in `failFromError`; align emitted codes with the README list
   (`INVALID_COLUMN` etc.) and keep absolute paths out of messages/details.

5. **Collapse the duplications** into single sources of truth: `gitCapture` for
   HEAD sha, a `resolveDeps(task, allTasks)` helper in `queries.ts`,
   `mutatingPreamble` for `new`, imported `EFFORT_VALUES`/`ATTENDANCE_VALUES`,
   and a shared editor-runner module.

6. **Harden the soft edges** flagged but downgraded by verification: tokenize
   `$EDITOR` and spawn argv instead of `sh -c "$EDITOR"`, and cap the `--body -`
   stdin read. Robustness, not security boundaries.

Built TDD outside-in at the CLI boundary, one commit per green behavior, per the
project's working method.

## Scope

### In scope

- As an agent, I can run `tasks new` concurrently with other agents/humans and
  every invocation either creates its task or fails loudly — none is silently
  dropped.
- As a user, concurrent mutations never leave the store dirty with an orphaned,
  uncommitted task file; every mutation is still exactly one commit.
- As a user, I can archive a task that other live tasks depend on and still
  `link`/`unlink`/`edit` those dependents.
- As a user, a forced `rm` leaves no archived task pointing at a deleted UUID.
- As a user, Short IDs are never duplicated even when `meta.yaml` drifts below
  the real maximum, and `tasks doctor` reports any duplicate ids it finds.
- As an agent, every failure (malformed task file, corrupt/transient git state,
  any internal error) returns a parseable `{error:{code,message,details}}`
  envelope, never a raw stack trace, including under `--json`.
- As an agent, every error code the CLI emits appears verbatim in the README
  error-envelope list.
- As a user, error output never discloses my absolute home/store path.
- As a maintainer, HEAD-sha lookup, the `deps_in`/`deps_out` projection, the
  mutating preamble, the effort/attendance enums, and the editor runner each
  have exactly one source of truth.
- As a user, a malformed or oversized `$EDITOR` value or an unbounded `--body -`
  stream is handled gracefully rather than executing unexpected shell or
  exhausting memory.

### Out of scope

- **Changing the path-encoding scheme or store directory layout.** ADR-0012's
  encoding is not injective at `/`-adjacent-`-` boundaries (e.g. `/a-/b` and
  `/a/-b` both encode to `-a---b`), so two legal-but-uncommon paths can collide
  to one store. Decision for this cycle: **document the limitation only**, no
  code change. See Open Questions.
- Migration of existing on-disk stores.
- The refuted non-null-assertion finding — verification showed TS already tracks
  `emit(): never`, so there is no masked bug to fix.
- Reworking the flock model itself (ADR-0013) or the six-column/status-by-
  directory model (ADR-0003); this work conforms to them, it does not revisit
  them.
- Configurable columns and an `unarchive` command (existing non-goals).

## Success Criteria

- A stress test firing N concurrent `tasks new` produces exactly N tasks, zero
  spurious `STORE_DIRTY`, and a clean tree afterward.
- After archiving a depended-on task, `link`/`unlink`/`edit` on its dependents
  succeed; after a forced `rm`, no archived task references a deleted UUID.
- With `meta.yaml` seeded below the real max, `tasks new` never creates a
  duplicate Short ID; `doctor` flags a pre-seeded duplicate.
- Dropping a malformed-frontmatter file into the store: every read and write
  command exits with a structured envelope and valid JSON under `--json`, never
  a stack trace; a forced non-`TasksError` (corrupt git HEAD) yields an
  `INTERNAL_ERROR` envelope with no absolute-path leak.
- `list`/`export`/`summary` emit only README-listed codes; the column-error
  tests assert `INVALID_COLUMN`.
- The full existing suite stays green, with new CLI-boundary tests covering each
  behavior above.

## Constraints

- TDD outside-in at the CLI boundary: tests spawn the binary against a
  `TASKS_HOME` tempdir and assert on stdout/stderr, exit codes, and on-disk
  state. No mocking of `git`. One commit per green (`green:` / `refactor:`).
- Mutating order is `flock → dirty guard → validate → write → commit`, and after
  this work the dirty guard, `ensureStore`, and commit all sit inside the lock.
- Error codes come verbatim from the README envelope list; `--json` stays
  opt-in on read commands.
- Single-binary Bun/TypeScript; no new runtime dependencies for the core fixes.

## Open Questions / Risks

- **Path encoding (ADR-0012) needs an injective redesign + migration before it
  can be fixed.** Documented-only this cycle. The ADR currently claims the
  encoding is "reversible," which is false at boundary cases — that claim and
  the known collision should be corrected in ADR-0012 via `domain-docs`, and a
  future ADR should propose an injective scheme and a store-migration path.
- **Moving `ensureStore` inside the lock interacts with first-time store
  creation.** The lock lives at `<store>/.tasks-lock`; acquiring it before the
  store dir / git repo exists needs care. Likely split "create store" (idempotent,
  pre-lock) from "mutate store" (in-lock), or confirm `flock` can create-and-lock
  a fresh path. Decide during the concurrency slice.
- **Flooring `next_id` scans `live ∪ archived` on every create** — confirm the
  cost is negligible at expected human/agent task volumes.
- **Tests currently assert `UNKNOWN_COLUMN`**; the code-fix slice must update
  those assertions to `INVALID_COLUMN` in the same change.
