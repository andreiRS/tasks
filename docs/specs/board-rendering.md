# Spec: `tasks board` rendering

Redesign of the default human output of `tasks board` as a horizontal, Trello-style kanban view with side-by-side columns. JSON output (`--json`) is unaffected.

Goal: a board layout that preserves the spatial workflow (left → right = lifecycle), gives every real column its own lane, makes dependencies visible, and degrades gracefully on narrower terminals.

## Status model

The store has six real columns (ADR-0003): `backlog`, `ready`, `doing`, `blocked`, `review`, `done`. A Task's column **is** its status. The board never derives a "virtual" status from dependencies — `ready` and `blocked` are real lanes a task is moved into, not states inferred from unmet deps. Dependencies are surfaced only as the `← #N` arrow on a task row, never by splitting a column into sub-sections.

## Behavior

### Layout

- Columns rendered side-by-side, separated by single-pipe vertical rules (`│`).
- Each column has the same anatomy (the "kanban lane" shape, see [K1 lane structure](#lane-structure) below).
- Column order, left to right (lifecycle): `backlog` → `ready` → `doing` → `blocked` → `review` → `done`. Every real column gets its own lane.

### Lane structure

Every column, populated or empty, has the same shape:

```
COLUMN_NAME (N)
──────────────
<body>
```

- **Header**: column name in lowercase or shouty-case (TBD by implementation — examples use ALL CAPS), followed by `(N)` where N is the task count.
- **Rule line**: a horizontal `─` underline as wide as the column. This is reserved space for future enhancements (WIP limits, filter chips, oldest-task age, etc.).
- **Body**: task rows for populated columns; the placeholder `no tasks` for empty columns.

### Empty columns

Empty columns are not hidden. They render as a slim "lane" using the same anatomy as populated columns, with `(0)` in the header and `no tasks` as the body. This preserves the spatial kanban mental model and keeps space available for future expansion (WIP, badges, hints) in the rule-line slot.

### Within-column order

Every lane lists its tasks short-ID ascending. There is no sub-structure or dependency-based clustering inside any column; dependency relationships are shown only via the `← #N` arrow on each task row.

### Task row

Each task row inside a column body:

```
#<id>  [auto] <title> ← #<dep>, #<dep>
```

- Short ID, padded so IDs align inside the column.
- `[auto]` tag only on unattended tasks; attended rows show a blank gutter of equal width.
- Title, truncated with `…` to fit the column width minus dep-arrow budget.
- Dep arrow `← #N, #N` only on rows with upstream deps.

### Dropped from the current output

- The `○` / `●` attendance glyph (replaced by `[auto]`).
- The effort tag (`·L`, `·M`, `·H`).
- The bracketed `[blocked by #N]` suffix (replaced by `← #N` arrow).

### Adaptive width

Designed for ~120 columns. Adaptive rule:

1. Render 4 columns side-by-side if width allows. Backlog gets a wider share (it carries the most content); other columns share the rest.
2. If width is tight, drop columns from the right in this priority order: `done`, then `review`. Hidden columns surface in a footer line: `hidden: 1 done · widen terminal or use \`tasks list\` to see all`.
3. **The moment fewer than 3 columns would be visible, fall back to the vertical (stacked) layout.** There is no 2-column intermediate.

The "3-column floor" applies to columns that *exist in the data*, not just non-empty ones. An empty column counts as present.

### Vertical fallback

When the horizontal layout cannot fit at least 3 columns, render a stacked view that uses the same conventions as the horizontal layout (lane header with count, rule line, backlog ready/blocked split, `[auto]` tag, dep arrows). Prefix with a single advisory line:

```
terminal narrow (<width> cols) · using vertical layout
```

## Example output

> **Stale:** the example blocks below predate the real-lanes model. They still show the removed virtual `ready`/`blocked` split inside `backlog` and a 4-column adaptive layout. They will be re-rendered as six real lanes once the board's adaptive-width questions (drop order, minimum-column floor, header case) are resolved in a dedicated board grill. Treat the prose rules above — not these blocks — as authoritative.

Same 10-task test data as [`list-rendering.md`](./list-rendering.md):

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

### Wide terminal (~130 cols) — all 4 columns

```
BACKLOG (6)                            │ DOING (2)                       │ REVIEW (1)                     │ DONE (1)
─────────────────────────────────────  │ ─────────────────────────────   │ ──────────────────────────     │ ─────────────────────────────
ready                                  │ #1   Design auth API surface    │ #9   [auto] Audit npm deps …   │ #10  Ship v1.2 release notes
  (none)                               │ #5   Migrate users table to v2  │                                │
                                       │                                 │                                │
blocked                                │                                 │                                │
  #2   Implement JWT signing …  ← #1   │                                 │                                │
  #3   Wire login endpoint      ← #1, #2 │                              │                                │
  #4   [auto] Add refresh tok…  ← #3   │                                 │                                │
  #7   Write integration test…  ← #3, #4 │                              │                                │
  #8   Document auth flow in …  ← #7   │                                 │                                │
  #6   [auto] Backfill email_…  ← #5   │                                 │                                │
```

Notes:
- (Stale rendering.) Under the real-lanes model `ready` and `blocked` are their own lanes; `backlog` has no internal split and lists its tasks short-ID ascending.
- `#4`, `#6`, `#9` carry the `[auto]` tag.

### Wide terminal with two empty columns — `review` and `done` empty

```
BACKLOG (6)                            │ DOING (2)                       │ REVIEW (0)  │ DONE (0)
─────────────────────────────────────  │ ─────────────────────────────   │ ──────────  │ ──────────
ready                                  │ #1   Design auth API surface    │   no tasks  │   no tasks
  (none)                               │ #5   Migrate users table to v2  │             │
                                       │                                 │             │
blocked                                │                                 │             │
  #2   Implement JWT signing …  ← #1   │                                 │             │
  #3   Wire login endpoint    ← #1, #2 │                                 │             │
  ...                                  │                                 │             │
```

Empty columns collapse to slim lanes (~10 cols) showing `(0)` and a `no tasks` body. Freed space is redistributed to populated columns.

### Mid-width (~85 cols) — `done` hidden

```
BACKLOG (6)                       │ DOING (2)                 │ REVIEW (1)
────────────────────────────────  │ ────────────────────────  │ ────────────────────────
ready                             │ #1   Design auth API …    │ #9   [auto] Audit npm …
  (none)                          │ #5   Migrate users tab…   │
                                  │                           │
blocked                           │                           │
  #2   Impl JWT sign…  ← #1       │                           │
  #3   Wire login end  ← #1, #2   │                           │
  #4   [auto] Add re…  ← #3       │                           │
  #7   Write integra…  ← #3, #4   │                           │
  #8   Document auth   ← #7       │                           │
  #6   [auto] Backfi…  ← #5       │                           │

hidden: 1 done · widen terminal or use `tasks list` to see all
```

### Narrow terminal — vertical fallback

When the 3-column floor cannot be met:

```
terminal narrow (55 cols) · using vertical layout

backlog (6)
──────────
  ready
    (none)
  blocked
    #2   Implement JWT signing helper       ← #1
    #3   Wire login endpoint                ← #1, #2
    #4   [auto] Add refresh token rotation  ← #3
    #7   Write integration tests for auth   ← #3, #4
    #8   Document auth flow in README       ← #7
    #6   [auto] Backfill email_verified fl  ← #5

doing (2)
──────────
  #1   Design auth API surface
  #5   Migrate users table to v2

review (1)
──────────
  #9   [auto] Audit npm deps for CVEs

done (1)
──────────
  #10  Ship v1.2 release notes
```

## Out of scope

- Re-rendering the example blocks as six real lanes (deferred to the board-focused grill, along with adaptive drop order, the minimum-column floor, and header case).
- Color (a follow-up may tint headers or unattended rows).
- WIP limits, filter chips, oldest-task age (planned to live in the rule-line slot but not in this spec).
- Drag-and-drop / interactive affordances (`+ add` prompts, drop zones).
- Any change to `--json` output.
- Any change to filtering flags (`--all`, `--since`).
