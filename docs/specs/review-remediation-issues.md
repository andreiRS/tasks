# Review Remediation: Issues

Vertical slices for `review-remediation.md`. Dependency-ordered; each slice is a
demoable, independently-grabbable change built TDD outside-in at the CLI boundary
(spawn the binary against a `TASKS_HOME` tempdir; assert stdout/stderr, exit
codes, on-disk state), one commit per green. Only slice 1 is attended.

Recommended order: 1 → 2 → 3, then the rest in any order respecting Blocked-by.
The data-integrity work (1-7) should land before the cleanup (11-18).

---

## 1. Decide store-creation vs in-lock guard composition

**Attendance:** attended (architectural decision)
**Covers:** unblocks the concurrency fixes; resolves the spec open question

### What to build

Decide how first-time store creation composes with running the dirty-tree guard
*inside* the flock. The lock lives at `<store>/.tasks-lock`; acquiring it before
the store directory and git repo exist is the open question. Two candidate
shapes: (a) `flock` create-and-locks a fresh path, store init happens under the
lock; or (b) an idempotent "create store" step runs pre-lock and only "mutate
store" runs in-lock. Pick one, with a one-paragraph rationale, so slices 2 and 3
have no architectural ambiguity left.

### Acceptance criteria

- [ ] A recorded decision (in the spec's Open Questions or a new ADR via `domain-docs`) states whether store init runs inside or outside the lock, and why.
- [ ] The decision specifies lock-acquisition behavior when `.tasks-lock` / the git repo does not yet exist.
- [ ] Slices 2 and 3 can proceed without further human input.

### Blocked by

None - can start immediately.

---

## 2. `tasks new` is concurrency-safe

**Attendance:** unattended
**Covers:** finding #2

### What to build

Make `createTask` run under the in-lock dirty-tree guard (`requireClean`), and
remove `new`'s racy pre-lock dirty check. Concurrent `tasks new` invocations must
serialize on the flock instead of a racing process seeing the first one's
written-but-uncommitted file as "dirty" and aborting with `STORE_DIRTY`.

### Acceptance criteria

- [ ] Firing N concurrent `tasks new` (e.g. 10) produces exactly N tasks with zero spurious `STORE_DIRTY`.
- [ ] `createTask` still rejects a genuinely dirty tree with `STORE_DIRTY` (now from inside the lock).
- [ ] The pre-lock dirty check no longer aborts a racing `new`.
- [ ] Existing concurrency and `new` tests stay green.

### Blocked by

#1.

---

## 3. All mutating commands guard inside the lock

**Attendance:** unattended
**Covers:** findings #3, #19

### What to build

Move `ensureStore` and the dirty-tree guard inside the flock in the shared
mutating preamble, and have `new` adopt that preamble instead of its inlined
copy. This eliminates the `.git/index.lock` race between a pre-lock
`ensureStore`/`git status` and another process's in-lock git, and removes the
third hand-typed copy of the `STORE_DIRTY` guard.

### Acceptance criteria

- [ ] A burst of concurrent mutating commands never fails with `GIT_ERROR` from a `.git/index.lock` collision and never leaves an orphaned untracked task file.
- [ ] The store tree is clean after the burst; every mutation is exactly one commit.
- [ ] `new` goes through the shared mutating preamble (no inlined flock / ensureStore / dirty-guard copy).

### Blocked by

#2.

---

## 4. Archiving a depended-on task keeps dependents editable

**Attendance:** unattended
**Covers:** finding #1

### What to build

Make the dependency graph archive-aware: `validateGraph` and the short-id/uuid
resolver maps in `editTask`/`linkTask`/`unlinkTask` resolve against
live ∪ archived tasks, so an edge into an archived task is valid (honoring
ADR-0010/0011), not a dangling `UNKNOWN_UUID`.

### Acceptance criteria

- [ ] After `mv A done; archive A` where a live task B depends on A, `link`, `unlink`, and `edit` on B all succeed.
- [ ] `show`/`next`/`export` still treat the archived dependency as complete (no regression).
- [ ] A genuinely unknown UUID still fails `UNKNOWN_UUID`.

### Blocked by

None - can start immediately.

---

## 5. `rm --force` cleans archived dependents

**Attendance:** unattended
**Covers:** finding #6

### What to build

Have `removeTask --force` strip the removed task's UUID from archived dependents
as well as live ones, in the same commit, so no archived task is left pointing at
a deleted UUID.

### Acceptance criteria

- [ ] After archiving A (which depends on T) then `rm T --force`, no archived task references T's UUID.
- [ ] `rm T` without `--force` still fails `DEP_EXISTS` when a live dependent exists.

### Blocked by

#4.

---

## 6. Short ID allocation is floored against the real maximum

**Attendance:** unattended
**Covers:** finding #4 (allocation)

### What to build

Allocate the next Short ID as `max(metaNextId, maxExistingId(live ∪ archived) + 1)`
with a pre-write uniqueness check, so `meta.yaml` drift can never produce a
duplicate-id file and the silent wrong-task resolution that follows.

### Acceptance criteria

- [ ] With `meta.yaml`'s `next_id` seeded below the real max, `tasks new` never creates a duplicate Short ID.
- [ ] A normal sequence of `tasks new` still yields monotonic, never-reused ids.
- [ ] A `new` that would collide picks the floored id instead.

### Blocked by

None - can start immediately.

---

## 7. `doctor` reports duplicate Short IDs

**Attendance:** unattended
**Covers:** finding #4 (detection)

### What to build

Teach `tasks doctor` to detect and report tasks sharing a Short ID, so a store
that already drifted is diagnosable in-tool.

### Acceptance criteria

- [ ] With two files sharing a Short ID, `doctor` flags the duplication and names the colliding id(s).
- [ ] A healthy store reports no duplicates.

### Blocked by

None - can start immediately.

---

## 8. Malformed task files degrade gracefully

**Attendance:** unattended
**Covers:** finding #5

### What to build

Guard every on-disk YAML/frontmatter parse so one malformed file cannot crash the
command with a raw stack trace. Skip-or-surface as a structured error (mirroring
how `validateEnums` already wraps its parse), so a single bad file does not brick
the whole store.

### Acceptance criteria

- [ ] With one malformed-frontmatter file present, `list`/`board`/`show`/`next`/`summary` and the mutating commands exit with a structured `{error:{code,message,details}}` envelope, and valid JSON under `--json`, never a stack trace.
- [ ] Commands that don't depend on the bad file still produce useful output where reasonable.

### Blocked by

None - can start immediately.

---

## 9. Top-level error boundary, no path leaks

**Attendance:** unattended
**Covers:** findings #6, #11

### What to build

Add a top-level boundary in the CLI entrypoint that converts any non-`TasksError`
into a sanitized `INTERNAL_ERROR` envelope (add the code to the README), stop
re-throwing unknown errors in `failFromError`, and keep absolute home/store paths
out of envelope messages and `details`.

### Acceptance criteria

- [ ] A forced non-`TasksError` (e.g. corrupt git HEAD during `summary`) yields an `INTERNAL_ERROR` envelope in both text and `--json` mode, exit 1, no stack trace.
- [ ] No error envelope message or `details` field contains an absolute home/store path.
- [ ] `failFromError` no longer re-throws unknown errors.
- [ ] `INTERNAL_ERROR` is listed in the README error-code table.

### Blocked by

None - can start immediately.

---

## 10. Error codes and messages match the README contract

**Attendance:** unattended
**Covers:** findings #7, #15

### What to build

Align emitted codes with the README list: `list`/`export` unknown-column emits
`INVALID_COLUMN` (not `UNKNOWN_COLUMN`), and `summary`'s invalid `--recent`/
`--stale` emit documented codes (not `INVALID_ARG`). Unify the `NOT_INITIALIZED`
message so list/board/export/summary give one consistent remediation. Update the
tests that currently assert the old codes.

### Acceptance criteria

- [ ] `list`/`export` unknown column emits `INVALID_COLUMN`; `summary` arg errors emit documented codes.
- [ ] `NOT_INITIALIZED` emits one consistent message across all four commands.
- [ ] Every code the CLI emits appears verbatim in the README error-code list.
- [ ] Tests asserting `UNKNOWN_COLUMN`/`INVALID_ARG` are updated.

### Blocked by

None - can start immediately.

---

## 11. Single source of truth for the HEAD sha

**Attendance:** unattended
**Covers:** finding #13

### What to build

Delete the duplicated private `readHeadSha` in `export` and `summary`; route both
through the existing exported `gitCapture(dir, ["rev-parse", "HEAD"])`, as the
store already does.

### Acceptance criteria

- [ ] `export` and `summary` produce identical HEAD-sha behavior (including the failure message) via `gitCapture`.
- [ ] Both private `readHeadSha` definitions are gone.
- [ ] All tests green.

### Blocked by

None - can start immediately.

---

## 12. Extract the shared dependency projection

**Attendance:** unattended
**Covers:** finding #18

### What to build

Extract the copy-pasted `deps_in`/`deps_out` projection from `show` and `next`
into one helper (e.g. `resolveDeps(task, allTasks)` in queries), so the
single-task JSON shape has one definition.

### Acceptance criteria

- [ ] `show` and `next` emit byte-identical `deps_in`/`deps_out` JSON as before, via the shared helper.
- [ ] All tests green.

### Blocked by

None - can start immediately.

---

## 13. Extract a shared editor runner

**Attendance:** unattended
**Covers:** finding #20

### What to build

Pull the duplicated `$EDITOR`/`$VISUAL` resolution, `NO_EDITOR` check, and spawn
into one module used by both `new` and `edit`.

### Acceptance criteria

- [ ] `new` and `edit` share one editor-resolution + spawn module.
- [ ] `NO_EDITOR` behavior (code and message) is unchanged.
- [ ] All tests green.

### Blocked by

None - can start immediately.

---

## 14. Spawn the editor as argv, not via `sh -c`

**Attendance:** unattended
**Covers:** finding #10

### What to build

Tokenize the `$EDITOR` value and spawn it as argv with no shell, instead of
interpolating it into `sh -c "$EDITOR \"$1\""`. Robustness/hardening: handles odd
editor values gracefully and removes the only shell invocation in the codebase.

### Acceptance criteria

- [ ] A multi-word `$EDITOR` (e.g. `code --wait`) still opens the file correctly.
- [ ] The editor is spawned as argv; no `sh -c` remains in the editor path.

### Blocked by

#13.

---

## 15. Import the shared effort/attendance enums

**Attendance:** unattended
**Covers:** finding #17

### What to build

Replace the locally redeclared `VALID_EFFORT`/`VALID_ATTENDANCE` consts in the
command files with imports of the existing `EFFORT_VALUES`/`ATTENDANCE_VALUES`
constants, so the enum sets have one source of truth.

### Acceptance criteria

- [ ] `list`/`set`/`next`/`new` use the imported constants; no local redeclarations remain.
- [ ] Enum-validation behavior is unchanged.

### Blocked by

None - can start immediately.

---

## 16. Shared positional-argument helper

**Attendance:** unattended
**Covers:** finding #16

### What to build

Add one `positionals(rest, { valueFlags })` helper that drops flags and their
values and returns ordered positionals, and use it across the commands that
currently hand-roll their own extraction. Note: the originally-reported `mv`
misparse does not actually occur (the column allowlist catches it), so this is a
consistency/reuse cleanup, not a bug fix.

### Acceptance criteria

- [ ] One shared helper replaces the per-command ad-hoc positional extraction.
- [ ] Behavior is unchanged for all valid inputs; unknown trailing flags are handled consistently across commands.

### Blocked by

None - can start immediately.

---

## 17. Shared short-id/uuid resolution helper

**Attendance:** unattended
**Covers:** finding #21

### What to build

Consolidate the duplicated "is this a short id or a uuid, resolve it" logic
(in `new`'s `--deps` resolution and `show`'s archive fallback) into one helper,
so the Short ID predicate has a single definition.

### Acceptance criteria

- [ ] `new` and `show` share one short-id-or-uuid resolution path.
- [ ] `UNKNOWN_UUID` behavior on an unresolvable ref is unchanged.

### Blocked by

None - can start immediately.

---

## 18. Cap the `--body -` stdin read

**Attendance:** unattended
**Covers:** finding #12

### What to build

Read the `--body -` stdin stream with a size cap, rejecting (or truncating with a
clear error) beyond a sane limit instead of buffering an unbounded payload into
memory and committing a multi-GB task file.

### Acceptance criteria

- [ ] An oversized `--body -` stream is rejected with a clear, documented error code rather than buffering unbounded.
- [ ] Normal-sized bodies are unaffected.

### Blocked by

None - can start immediately.
