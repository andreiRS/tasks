# Dependency visibility in `list`, `board`, and `show`

Status: proposed, not implemented. Drafted for a future session — do not
implement from this doc directly; treat it as a problem statement, not a
spec.

## Problem

When several tasks are linked into a chain (`#7` depends on `#5` and
`#6`; `#6` depends on `#5`), neither `tasks list` nor `tasks board`
gives any visible signal that those rows are related. The kanban view
looks identical whether the four backlog items are independent or
strictly ordered.

### Observed output (2026-05-28)

After filing the three `tasks doctor` slices, where #6 is blocked by #5
and #7 is blocked by both:

```
tasks list

#3  backlog   Test again creation                                          O·M
#5  backlog   tasks doctor reports store path, git status, and stash count O·M
#6  backlog   tasks doctor --clean stashes everything to recover ...       O·M
#7  backlog   tasks doctor --json emits structured diagnostics ...         O·M
#4  ready     Test again mv                                                O·M
#2  doing     Say Good Evening                                             O·M
#1  done      Say Hello                                                    O·M

tasks board

backlog
  #3 Test again creation                                          O·M
  #5 tasks doctor reports store path, git status, and stash count O·M
  #6 tasks doctor --clean stashes everything to recover ...       O·M
  #7 tasks doctor --json emits structured diagnostics ...         O·M
ready
  #4 Test again mv                                                O·M
doing
  #2 Say Good Evening                                             O·M
blocked (empty)
review (empty)
done
  #1 Say Hello                                                    O·M
```

`#3`, `#5`, `#6`, `#7` are visually interchangeable. Nothing hints that
picking up `#7` first would be wrong, or that `#5` is the only one
actually free to start.

### Side observation: `show` deps are raw UUIDs

`tasks show 7` currently renders:

```
deps:          28719a78-5216-4718-b4ba-217dc41f3bc3
               724ca6fb-d35e-4cf1-9646-4c3f180eccb9
```

The PRD says `show` "renders deps with their `#id title`". The current
output drops the human-meaningful part, so even after drilling into a
single task the dependency chain stays opaque.

## What "good" might look like (sketch only, no decision)

Multiple shapes are worth weighing in a focused session; do not pick
one from this doc.

- **Inline indicators per row.** Append a marker to each row indicating
  blocked/free status and the count of unresolved deps, e.g.
  `#7 ... [blocked by 2]` or a glyph (`⛔` / `▶`). Cheap, fits both
  `list` and `board`.
- **Resolved dep ids in `show`.** Restore the PRD-promised
  `#id title` rendering for the `deps:` block, plus the inverse
  ("blocks: #N title") so the chain is navigable in both directions.
  Independent of `list`/`board` and probably should land first.
- **Indented chains in `list`.** Group blocked tasks under the task
  they're waiting on. Visually clear for tight chains, falls apart on
  diamonds and cross-column deps.
- **Topological sort within a column.** Inside each column, render
  tasks in dependency order (roots first). Subtle but doesn't require
  new glyphs; combines well with the inline-indicator option.
- **Per-row "depth" or "wave" number.** A small number indicating how
  many predecessors block this task transitively. Sortable; reveals
  parallelism (everything at depth 0 is grabbable).
- **A separate `tasks deps` / `tasks graph` view.** Dedicated rendering
  for the DAG (ASCII tree or, with `--json`, machine-readable).
  Heavier; might be the right home for richer signal than `list`/`board`
  can fit.

## Questions to resolve next session

- Which view(s) should change — `list` only, `board` only, both, plus a
  new command?
- What signal is most valuable: "is this blocked right now?", "what
  blocks it?", or "in what order should I work?"
- Should `tasks next`'s logic (ready + all deps done) be surfaced more
  directly inside `list`/`board` (e.g. highlight all rows that satisfy
  it), or kept as its own command?
- How should the change interact with the `--json` contract — extend
  the existing schema, or only enrich the human renderer?
- Is the `show` deps-as-UUID rendering a bug to fix immediately
  (independent of any list/board redesign), or part of the same effort?

## Out of scope for this doc

- Choosing an implementation. This is a problem statement.
- Any change to the dependency *model* (still a flat DAG of UUID refs).
- Visual styling decisions (colors, glyphs) — those follow from the
  shape choice above.
