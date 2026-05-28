# Spec: `tasks list` rendering

Redesign of the default human output of `tasks list`. JSON output (`--json`) is unaffected by this spec.

Goal: a flat, scannable list ordered so the working set surfaces first and the raw backlog sinks to the bottom, makes dependencies visible at a glance, drops noise from the current rendering, and exposes the unattended/agent-eligible signal without a legend.

## Status model

The store has six real columns (directory-backed, ADR-0003): `backlog`, `ready`, `doing`, `blocked`, `review`, `done`. A Task's column **is** its status. This view never derives a "virtual" status from dependencies — `ready` and `blocked` are real columns a task is moved into, not states inferred from unmet deps. Dependencies are surfaced only as the `← #N` annotation (see [Dependency arrow](#dependency-arrow)), never by reordering rows into sub-sections.

## Behavior

### Layout

- Flat list. No column headers, no per-status sub-headers, no sub-sections.
- One task per line.
- Fields, left to right, separated by a 2-space gap:
  1. **Short ID** (`#1`, `#10`, …) left-aligned, padded to the width of the widest id in the displayed set so ids align on the left edge.
  2. **Column name** (`backlog`, `ready`, `doing`, `blocked`, `review`, `done`) lowercase, padded to a fixed width of 7 (the longest name, `backlog`).
  3. **`[auto]` gutter** — present only when at least one displayed task is unattended. When present it sits between the column name and the title: unattended rows render `[auto]`, attended rows render an equal-width blank so titles stay aligned. When the displayed set contains no unattended task, the gutter is omitted entirely and the layout is tighter.
  4. **Title**, padded/truncated to a fixed title field (see [Width budget](#width-budget)).
  5. **Dependency arrow** `← #N, #N` — only on rows with unmet upstream blockers, aligned to a fixed tab stop so arrows form a vertical strip.

### Sort order

Two-level sort:

1. **Status order** (top to bottom):
   `ready` → `doing` → `blocked` → `review` → `done` → `backlog`.
   This front-loads the working set in lifecycle order (a task becomes `ready`, then `doing`, may get `blocked`, goes to `review`, then `done`) while pushing the two low-signal piles — completed work (`done`, already trimmed by `--since`) and the raw `backlog` — to the bottom.
2. **Within each status**: short-ID ascending. No clustering, no dependency-based reordering. Dependency relationships remain visible through the `← #N` arrow.

Empty statuses contribute no lines (the flat list has no headers, so an empty column is simply absent).

### Dependency arrow

- Lists the task's **unmet direct upstream blockers**: direct deps that are not yet complete. A dep in `done` or `archive` counts as complete and is excluded; a dangling dep (unknown uuid) is excluded. This is the same set as the `blockedBy` field in `--json` (one source of truth, `computeBlockedBy`).
- A task whose every direct dep is complete shows **no arrow**, even if it sits in `backlog`.
- Arrows render on rows in **any** column, not just `backlog` (e.g. a `doing` task with an unmet blocker shows one).
- Rendered as `← #N, #N` with ids in ascending order.
- Aligned to a fixed tab stop: the arrow always begins immediately after the title field, so arrows line up vertically.

### Width budget

Designed for a fixed ~120-column target. Layout is **not** adaptive to the actual terminal width (out of scope); every render lays out to the same 120-col budget.

Let `GAP = 2`, `COL_W = 7`, `GUTTER_W = 6`, `ARROW_RESERVE = 12`, and `idW` = width of the widest `#<id>` in the displayed set.

```
prefix  = idW + GAP + COL_W + GAP + (anyUnattended ? GUTTER_W + GAP : 0)
titleW  = max(10, 120 − prefix − GAP − ARROW_RESERVE)
```

- Titles longer than `titleW` truncate with a trailing `…` (the ellipsis counts as one column).
- The arrow tab stop is `prefix + titleW + GAP`; the arrow tail gets the remaining width (`ARROW_RESERVE`, ≥ 12).
- **Long blocker lists** that don't fit the tail truncate with a ` +N` suffix counting the hidden ids (e.g. `← #3, #4 +3`). Room for ` +N` is reserved when deciding how many ids fit, so the tail never itself overflows. At least one id is always shown.

For the 10-task example below: `idW = 3`, gutter present, so `prefix = 22`, `titleW = 84`, arrows pin at column 108.

### Color

- Color is gated exactly as today (`--no-color` / `NO_COLOR` / `FORCE_COLOR` / TTY detection).
- Styling is preserved on the surviving elements only: **short ID bold**, **column name cyan**. The `[auto]` gutter and the dependency arrow are not tinted.
- Stripping ANSI escapes from a colored render must yield byte-for-byte the plain render.
- No new tints in this spec (tinting unattended rows / status names is a follow-up).

### What is dropped from the current output

- The `○` / `●` attendance glyph (the `[auto]` gutter carries the unattended signal instead).
- The effort tag (`·L`, `·M`, `·H`).
- The bracketed `[blocked by #N]` suffix (replaced by the `← #N` arrow).

### Empty list

If no tasks match: print `(no tasks)` and exit 0.

## Example output

Test data (10 tasks):

- `#1` doing — Design auth API surface
- `#2` backlog (blocked by #1) — Implement JWT signing helper
- `#3` backlog (blocked by #1, #2) — Wire login endpoint
- `#4` backlog [auto] (blocked by #3) — Add refresh token rotation
- `#5` doing — Migrate users table to v2
- `#6` backlog [auto] (blocked by #5) — Backfill missing email_verified flag
- `#7` backlog (blocked by #3, #4) — Write integration tests for auth
- `#8` backlog (blocked by #7) — Document auth flow in README
- `#9` review [auto] — Audit npm deps for CVEs
- `#10` done — Ship v1.2 release notes

Expected `tasks list` output (titles pad to an 84-col field; arrows pin at column 108):

```
#1   doing            Design auth API surface
#5   doing            Migrate users table to v2
#9   review   [auto]  Audit npm deps for CVEs
#10  done             Ship v1.2 release notes
#2   backlog          Implement JWT signing helper                                                          ← #1
#3   backlog          Wire login endpoint                                                                   ← #1, #2
#4   backlog  [auto]  Add refresh token rotation                                                            ← #3
#6   backlog  [auto]  Backfill missing email_verified flag                                                  ← #5
#7   backlog          Write integration tests for auth                                                      ← #3, #4
#8   backlog          Document auth flow in README                                                          ← #7
```

Notes about the example:

- `doing` (`#1`, `#5`) leads, then `review` (`#9`), then `done` (`#10`), then `backlog` (`#2`, `#3`, `#4`, `#6`, `#7`, `#8`). There are no `ready` or `blocked` tasks in this data, so those statuses contribute no lines.
- Within every status, rows are short-ID ascending. Backlog is **not** clustered by blocker — `#6` follows `#4` only because `6 > 4`, not because of its dependency.
- `#4`, `#6`, `#9` are unattended, so the set reserves the `[auto]` gutter; attended rows show an equal-width blank in that gutter.
- `#10` (done) has no blockers and shows no arrow; every backlog row here has an unmet blocker and shows one.

### Truncation behavior

When a blocker list overflows the 12-col tail (here with wider ids for illustration):

```
← #1                  (1 dep)
← #1, #2              (2 deps)
← #3, #4, #5          (3 deps, exactly fits)
← #3, #4 +3           (5 deps → 2 shown, +3 hidden)
← #10 +5              (6 wide-id deps → 1 shown, +5 hidden)
```

## Out of scope

- Color tinting of unattended rows or status names (a follow-up).
- Adaptive widths for terminals wider or narrower than the fixed ~120-col budget.
- Any change to `--json` output.
- Any change to filtering flags (`--column`, `--attendance`, `--effort`, `--all`, `--since`, `--archived`).
