# Spec: `tasks board` rendering

Redesign of the default human output of `tasks board` as a horizontal, Trello-style kanban view with side-by-side lanes that adapts to terminal width, drops lanes from the right under pressure, and falls back to a stacked vertical layout when too narrow. JSON output (`--json`) is unaffected.

Goal: a board layout that preserves the spatial workflow (left → right = lifecycle), gives every real column its own lane, makes dependencies visible, and degrades gracefully on narrower terminals.

This spec resolves the adaptive-width, drop-order, minimum-column-floor, and header-case questions previously deferred from the list-rendering work. The prose rules and the example blocks below are both authoritative.

## Status model

The store has six real columns (ADR-0003): `backlog`, `ready`, `doing`, `blocked`, `review`, `done`. A Task's column **is** its status. The board never derives a "virtual" status from dependencies — `ready` and `blocked` are real lanes a task is moved into, not states inferred from unmet deps. Dependencies are surfaced only as the `← #N` arrow on a task row, never by splitting a column into sub-sections. Every real column gets its own lane; there is no internal split inside any lane.

## Width budget

The board sizes itself against a width budget resolved in this order:

1. `process.stdout.columns` when stdout is a TTY.
2. Otherwise `Number(process.env.COLUMNS)` when that env var is set and parses to a positive number.
3. Otherwise `120`.

This keeps full adaptivity on real terminals while staying deterministic under the test harness (which spawns the binary against piped, non-TTY stdout): a test sets `COLUMNS` to drive any adaptive branch, and with no `COLUMNS` set the board renders the 120-col layout.

The board never renders wider than the sum of all visible lane widths plus separators. On an ultra-wide terminal lanes stay at their fixed widths (below) and the remaining space is left blank — the board does not stretch lanes to fill.

## Layout

- Lanes rendered side-by-side, separated by ` │ ` (space, single-pipe vertical rule, space — `SEP = 3` columns).
- Column order, left to right (lifecycle): `backlog` → `ready` → `doing` → `blocked` → `review` → `done`.
- Each lane, populated or empty, has the same anatomy (see [Lane structure](#lane-structure)).

### Fixed lane widths

Lane content widths are fixed constants, not proportional splits (this matches `tasks list`'s fixed-tab-stop philosophy and keeps golden-test output stable):

| Lane                     | Width |
|--------------------------|-------|
| `backlog` (when populated) | `36` |
| any other lane (populated) | `24` |
| any lane with `0` tasks    | `11` (slim) |
| separator ` │ `            | `3`  |

A lane's width is `EMPTY_W` (11) if it has zero tasks, else `BACKLOG_W` (36) for `backlog` or `OTHER_W` (24) for any other column. The slim width (11) is the minimum that holds the widest empty header (`BACKLOG (0)` = 11 chars).

### Fit and drop algorithm

1. Compute each present lane's width per the table above (all six columns are always "present", even when empty).
2. `required = Σ lane widths + SEP × (n − 1)` where `n` is the number of currently-visible lanes.
3. While `required > budget` **and** `n > 3`: drop the highest-priority droppable lane, recompute, repeat.
4. If, with exactly 3 lanes visible, `required` still exceeds `budget`, abandon the horizontal layout and render the [vertical fallback](#vertical-fallback).

**Drop priority** (first dropped → last), right-to-left along the lifecycle, always keeping a contiguous left prefix:

```
done  →  review  →  blocked
```

`backlog`, `ready`, and `doing` are never dropped horizontally — they are the 3-lane floor. The moment fewer than 3 lanes can fit, the board switches to vertical. There is no 2-lane intermediate. Dropping is purely width-driven; an empty lane is never dropped ahead of a populated one (this preserves lifecycle contiguity — the board never shows a gap such as `backlog │ doing │ review`).

```
6: backlog ready doing blocked review done
5: backlog ready doing blocked review        (drop done)
4: backlog ready doing blocked               (drop review)
3: backlog ready doing                        (drop blocked)
<3 fit: vertical fallback
```

### Hidden-lanes footer

When any lane is dropped, a single footer line follows the board (blank line, then the footer). It lists the hidden lane names in lifecycle order, each with its task count in parens (the same `(N)` convention as headers):

```
hidden: done (1) · widen terminal or run `tasks list` to see all
```

Multiple hidden lanes are comma-separated in lifecycle order:

```
hidden: review (1), done (1) · widen terminal or run `tasks list` to see all
```

## Lane structure

Every lane, populated or empty, has the same shape:

```
HEADER (N)
──────────────
<body>
```

- **Header**: column name in uniform ALL CAPS, followed by `(N)` where N is the lane's task count. Always caps, even for empty lanes — emptiness is conveyed by the count and body, not by case, so a header never changes case as its lane fills or empties.
- **Rule line**: a horizontal `─` underline. In the horizontal layout it spans the full lane width. (In the vertical fallback it spans the header text width — see below.) This is reserved space for future enhancements (WIP limits, filter chips, oldest-task age, etc.).
- **Body**: task rows for populated lanes; the placeholder `no tasks` for empty lanes.

### Empty lanes

Empty lanes are not hidden under normal width. They render as a slim 11-col lane using the same anatomy as populated lanes, with `(0)` in the header and `no tasks` as the body. This preserves the spatial kanban mental model and keeps the rule-line slot available for future expansion. (Empty lanes can still be dropped under width pressure, but only after the populated lanes to their right per the drop priority.)

### Within-lane order

Every lane lists its tasks short-ID ascending. There is no sub-structure or dependency-based clustering inside any lane; dependency relationships are shown only via the `← #N` arrow on each task row.

### Task row

Each task row inside a lane body:

```
#<id>  [auto] <title>…   ← #<dep> +<k>
```

Within a lane of content width `W`:

- **Short ID**: `#<id>`, left-padded to `idW` = the widest `#id` among that lane's tasks, so IDs align within the lane.
- **`[auto]` gutter**: the literal tag `[auto]` (6 cols) appears only on unattended task rows. The gutter is reserved **per lane**: a lane reserves the 6-col gutter (and a gap) only if it contains at least one unattended task; in a lane with no unattended tasks, no gutter is reserved and titles get that room.
- **Title**: fixed width = `W − idW − GAP − (gutter? 6 + GAP : 0) − (arrowReserve? GAP + arrowReserve : 0)`, clamped to a small minimum, truncated with `…` to fit.
- **Dep arrow**: right-pinned to the lane's right edge. The arrow reserve is taken **per lane** — a lane reserves the arrow tail only if at least one of its tasks has upstream deps. The arrow shows the first upstream short ID; additional deps overflow as ` +k`. The reserve is `2 + idW + 3` columns (covers `← #<id>` plus a ` +k` overflow marker). A row with no deps shows blank in that reserved tail (so arrows align down the lane); a single dep shows just `← #N` with no `+k`.

Both the `[auto]` gutter and the arrow reserve are computed **per lane** (present only in lanes that actually need them) — lanes are independent columns and need no cross-lane alignment.

### Dropped from the previous output

- The `○` / `●` attendance glyph (replaced by the `[auto]` tag).
- The effort tag (`·L`, `·M`, `·H`).
- The bracketed `[blocked by #N]` suffix (replaced by the `← #N` arrow).
- The `--blocked-by` flag is **removed** from `tasks board`. Arrows are unconditional, so the flag has no job; passing it now errors as an unknown flag. (Acceptable pre-1.0; arrows subsume it.)

## Vertical fallback

When the horizontal layout cannot fit at least 3 lanes, the board renders a stacked view: each column as its own block (`HEADER (N)` / rule line / rows), top-to-bottom in the same lifecycle order as the horizontal layout (`backlog` → `ready` → `doing` → `blocked` → `review` → `done`), reusing the board's row conventions (`[auto]` tag, right-pinned `← #N` arrows). Empty lanes are still shown with a `no tasks` body, preserving parity with the horizontal view. This is distinct from `tasks list` (a single flat, working-set-first table): the vertical fallback keeps per-lane headers and counts.

In the vertical layout the rule line spans the header text width (not a lane width — there is no horizontal lane constraint). Title/arrow widths use the full vertical content width.

The view is prefixed with a single advisory line and a blank line:

```
terminal narrow (<width> cols) · using vertical layout
```

`<width>` is the resolved width budget.

## Styling

Headers are rendered bold (consistent with `tasks list`); the rest matches list conventions. Under `--no-color` / non-TTY all ANSI is stripped and the layout is byte-for-byte identical aside from the escape codes. Color tinting of headers or unattended rows is a deferred follow-up (out of scope).

## Example output

Same 10-task test data as [`list-rendering.md`](./list-rendering.md), under the real-lanes model. Note the dependency tasks live in `backlog` (they have unmet deps but have not been *moved* into a `blocked` lane), so `ready` and `blocked` are empty:

- `#1` doing — Design auth API surface
- `#2` backlog (← #1) — Implement JWT signing helper
- `#3` backlog (← #1, #2) — Wire login endpoint
- `#4` backlog [auto] (← #3) — Add refresh token rotation
- `#5` doing — Migrate users table to v2
- `#6` backlog [auto] (← #5) — Backfill missing email_verified flag
- `#7` backlog (← #3, #4) — Write integration tests for auth
- `#8` backlog (← #7) — Document auth flow in README
- `#9` review [auto] — Audit npm deps for CVEs
- `#10` done — Ship v1.2 release notes

Lane widths for this data: `backlog` 36 (populated), `ready` 11 (empty), `doing` 24, `blocked` 11 (empty), `review` 24, `done` 24.

### Wide terminal (~150 cols) — all six lanes

`required = 36 + 11 + 24 + 11 + 24 + 24 + (3 × 5) = 145 ≤ 150`, so all six lanes fit.

```
BACKLOG (6)                          │ READY (0)   │ DOING (2)                │ BLOCKED (0) │ REVIEW (1)               │ DONE (1)
──────────────────────────────────── │ ─────────── │ ──────────────────────── │ ─────────── │ ──────────────────────── │ ────────────────────────
#2  Implement JWT signing…   ← #1    │ no tasks    │ #1  Design auth API surf │ no tasks    │ #9  [auto] Audit npm dep │ #10  Ship v1.2 release n
#3  Wire login endpoint…     ← #1 +1 │             │ #5  Migrate users table  │             │                          │
#4  [auto] Add refresh tok…  ← #3    │             │                          │             │                          │
#6  [auto] Backfill email_…  ← #5    │             │                          │             │                          │
#7  Write integration test…  ← #3 +1 │             │                          │             │                          │
#8  Document auth flow in …  ← #7    │             │                          │             │                          │
```

Notes:
- `backlog` lists its tasks short-ID ascending; no internal `ready`/`blocked` split.
- `#4`, `#6`, `#9` carry the `[auto]` tag. The `backlog` lane reserves the gutter (it has unattended tasks); `doing`/`done` do not.
- `doing`, `review`, `done` reserve no arrow tail (none of their tasks have deps), so their titles use the full lane width.

### 120-col default — `done` dropped to footer

`required` for all six = 145 > 120. Drop `done` (saves 24 + 3): `145 − 27 = 118 ≤ 120`. Five lanes shown; `done` footered.

```
BACKLOG (6)                          │ READY (0)   │ DOING (2)                │ BLOCKED (0) │ REVIEW (1)
──────────────────────────────────── │ ─────────── │ ──────────────────────── │ ─────────── │ ────────────────────────
#2  Implement JWT signing…   ← #1    │ no tasks    │ #1  Design auth API surf │ no tasks    │ #9  [auto] Audit npm dep
#3  Wire login endpoint…     ← #1 +1 │             │ #5  Migrate users table  │             │
#4  [auto] Add refresh tok…  ← #3    │             │                          │             │
#6  [auto] Backfill email_…  ← #5    │             │                          │             │
#7  Write integration test…  ← #3 +1 │             │                          │             │
#8  Document auth flow in …  ← #7    │             │                          │             │

hidden: done (1) · widen terminal or run `tasks list` to see all
```

### Mid-width (~95 cols) — `done` and `review` dropped

All six = 145; drop `done` → 118; drop `review` (24 + 3) → `118 − 27 = 91 ≤ 95`. Four lanes shown.

```
BACKLOG (6)                          │ READY (0)   │ DOING (2)                │ BLOCKED (0)
──────────────────────────────────── │ ─────────── │ ──────────────────────── │ ───────────
#2  Implement JWT signing…   ← #1    │ no tasks    │ #1  Design auth API surf │ no tasks
#3  Wire login endpoint…     ← #1 +1 │             │ #5  Migrate users table  │
#4  [auto] Add refresh tok…  ← #3    │             │                          │
#6  [auto] Backfill email_…  ← #5    │             │                          │
#7  Write integration test…  ← #3 +1 │             │                          │
#8  Document auth flow in …  ← #7    │             │                          │

hidden: review (1), done (1) · widen terminal or run `tasks list` to see all
```

### Narrow terminal — vertical fallback

When fewer than 3 lanes fit (`backlog 36 + ready 11 + doing 24 + 2×SEP = 77 > 55`):

```
terminal narrow (55 cols) · using vertical layout

BACKLOG (6)
───────────
#2  Implement JWT signing helper        ← #1
#3  Wire login endpoint                 ← #1 +1
#4  [auto] Add refresh token rotation   ← #3
#6  [auto] Backfill email_verified fla  ← #5
#7  Write integration tests for auth    ← #3 +1
#8  Document auth flow in README        ← #7

READY (0)
───────────
no tasks

DOING (2)
───────────
#1  Design auth API surface
#5  Migrate users table to v2

BLOCKED (0)
───────────
no tasks

REVIEW (1)
───────────
#9  [auto] Audit npm deps for CVEs

DONE (1)
───────────
#10  Ship v1.2 release notes
```

## Out of scope

- Color (a follow-up may tint headers or unattended rows).
- WIP limits, filter chips, oldest-task age (planned to live in the rule-line slot but not in this spec).
- Drag-and-drop / interactive affordances (`+ add` prompts, drop zones).
- Any change to `--json` output.
- Any change to filtering flags (`--all`, `--since`).
