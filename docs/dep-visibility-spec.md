# Dependency visibility: implementation spec

Status: ready to implement. Derived from `docs/dep-visibility.md` (problem
statement) through a focused grilling session on 2026-05-28.

## Summary

Three vertical slices, landed in this order, each its own green commit:

1. `show` renders `deps:` as `#id title` (PRD compliance fix).
2. `show` adds a reverse `blocks:` block listing tasks that depend on this one.
3. `list` and `board` append a `[blocked by #N,#M]` marker to rows with
   unresolved dependencies.

Each slice is independent and shippable on its own.

## Slice 1: `show` deps as `#id title`

### Behaviour
- The `deps:` block in `tasks show <id>` renders each dependency as
  `#<shortId> <title>`, one per line, replacing the current raw UUID list.
- Indentation and label width follow the existing `show` layout.

### Unresolved deps
- If a dep UUID cannot be resolved to a current task (orphan / corruption),
  render the line as `<unknown> <uuid>` instead of erroring.
- `tasks show` exit code stays `0`. Detecting and reporting corruption is
  the validator's job, not `show`'s.

### `--json`
- No change. The existing `--json` schema for `show` is preserved in this
  slice. (Revisit later if a consumer needs the richer view.)

### Tests
- Task with multiple resolvable deps renders each as `#id title`.
- Task with a dangling dep UUID renders `<unknown> <uuid>` and exits `0`.
- Task with no deps renders the `deps:` block as it does today (empty /
  absent, whichever is current).
- `show --json` output for the same fixture is byte-identical to before.

## Slice 2: `show` adds `blocks:` reverse lookup

### Behaviour
- After the `deps:` block, `show` renders a `blocks:` block listing every
  task whose `deps` includes this task, formatted as `#<shortId> <title>`,
  one per line.
- If nothing depends on this task, the `blocks:` block is omitted entirely
  (no empty label line).
- Ordering: sorted ascending by short id, for stable output.

### Implementation note
- Computed by scanning all tasks in the store once and inverting the dep
  graph. Acceptable cost for read commands at expected store sizes.

### `--json`
- No change in this slice (same rationale as slice 1).

### Tests
- Task with two dependants renders both, sorted by short id.
- Task with no dependants does not emit a `blocks:` label.
- A done dependant still appears (state does not filter the reverse list;
  declared dep is declared dep).

## Slice 3: `list` / `board` blocker marker

### Marker syntax
- Rows with one or more **unresolved** blockers get a trailing marker:
  `[blocked by #5,#6]` — explicit short ids, comma-separated, no spaces.
- Direct blockers only. Transitive blockers are not surfaced here.
- Done blockers are filtered out. If all declared blockers are `done`,
  the row has no marker.
- Rows with no unresolved blockers have no marker at all (not even a
  placeholder).

### Position and layout
- Marker is appended at the far right of the row, *after* the `O·M`
  (owner) column.
- Row alignment: ragged right. No padding to align the `O·M` column
  across rows. Free tasks render shorter; this is itself a visual signal.
- Marker width is not capped. Chains are short in practice (1-3 ids);
  revisit only if real-world output bloats.

### Scope of columns
- The marker applies to **every** column where a task has unresolved
  blockers, including `doing`, `review`, and `done`. A task in `doing`
  with an unresolved blocker is exactly the anomaly worth surfacing.
- A `done` task with an unresolved blocker is rare but rendered for
  consistency.

### Both views
- `list` and `board` share the same marker, same position, same rules.
- Implementation should share a row-rendering helper between the two
  commands.

### `--json`
- Both `list --json` and `board --json` add a `blockedBy: [shortId, ...]`
  field to each row.
- The array contains short ids only (strings or numbers, matching the
  existing `id` field's type in the schema).
- The array contains **unresolved** blockers only — same filtering as
  the human marker. Empty array when nothing is blocking.
- Done blockers are excluded.

### Out of scope
- No `--blocked` / `--free` filter flags. Filtering is left to shell
  pipelines for now. Revisit if usage suggests demand.
- No new `tasks deps` / `tasks graph` command.
- No topological sort within a column.
- No indented chains, depth/wave numbers, or glyphs.
- No styling (color, dim, strikethrough). Plain text only.

### Tests
- `list` and `board` each:
  - Row with two unresolved direct blockers shows `[blocked by #5,#6]`
    after `O·M`.
  - Row with all blockers in `done` shows no marker.
  - Row in `doing` with unresolved blocker shows the marker.
  - Row with no deps shows no marker.
  - Order of ids in marker is ascending by short id.
- `--json`: same fixtures assert `blockedBy` array contents (unresolved
  short ids only; empty array when none).

## Non-goals (across all slices)

- No change to the dependency *model*. Still a flat DAG of UUID refs.
- No change to validator rules or error codes.
- No change to `tasks next` semantics.
- No `--json` change to `show` (deferred).

## Working method

- TDD outside-in at the CLI boundary, per `CLAUDE.md`.
- Each slice is a `green:` commit, refactors land as separate `refactor:`
  commits from and to green.
- No mocking; tests spawn the binary against a `TASKS_HOME` tempdir and
  assert on stdout / stderr / exit code / on-disk state.
