---
name: tasks
description: >-
  Track multi-step work as it happens using the `tasks` CLI (a git-backed kanban
  for human + agent task management). Reach for it on any job of three or more
  steps or with ordering between them — a feature with impl-then-tests, a
  multi-file refactor, a migration, a bug hunt whose fix depends on a repro.
  Create each slice's card before you start it (not after), wire up dependencies,
  and move tasks across columns as you go, so work survives a dropped session and
  the user can watch it live. Also use it when the user talks to the board
  directly: "add a task", "what's blocking X", "show me the board", "what should
  I pick up next". Do NOT use it for a single one-shot edit — the bookkeeping
  isn't worth it.
---

# tasks

`tasks` is a single-binary CLI: each task is a markdown file with YAML
frontmatter in a per-project git repo, and every change is one git commit (so the
board is also an audit log). Six columns:

```
backlog → ready → doing → blocked → review → done
```

Two modes: **primary** — track your own multi-step work as you do it; **secondary**
— run the board for the user when they talk to it directly.

This file teaches judgment, not flags: for the exact surface run `tasks --help`
and `tasks <cmd> --help`, and on a rejection read the error code and message
before guessing. If `tasks` isn't on `PATH`, run it from the tasks checkout with
`bun run src/cli.ts ...`. Run every command from inside the repo you're tracking —
the store is keyed by the nearest `.git` ancestor, so cd-ing out of the repo
silently hits a different store (an empty board usually means you're in the wrong
place).

## Primary: track your own work

**When.** Track a job of 3+ steps or with real ordering. Skip it for a trivial
one-shot (typo, one-liner, quick read) — a card there is the busywork this skill
exists to avoid. Borderline and small → skip.

**Card first, then work.** For a tracked job, create each slice's card and move it
to `doing` *before* the first edit or command for it, not after. The board mirrors
what you're doing *now*; code-first-log-later means a dropped session loses the
slice. Editing a tracked job with nothing in `doing`? Stop, make the card.

A slice is one line on a board ("Add rate-limit middleware", not "type a
function"). Create them up front if you can see the shape, else as you go.

```sh
tasks new "Add rate-limit middleware" --unattended   # capture "#<id>"; --unattended = agent work
tasks new "Tests for rate limiter" --unattended --deps 4   # 4 = middleware id (or: tasks link <id> --depends-on <id>)
tasks mv 4 ready
tasks next --unattended    # oldest ready task whose deps are all done
tasks mv 4 doing           # ...do the work...
tasks mv 4 review          # if it needs checking
tasks mv 4 done
```

Any move is legal (`mv` never enforces deps). Use `blocked` when something
external stalls a task. A linear job can be just `new → doing → done`;
`ready`/`next` earn their keep only with real dependencies.

**Offer the board once.** The first time you track in a session: `tasks init`,
then `tasks serve` in the background, and say one line — "watch it live at
http://127.0.0.1:4317". Don't repeat it. `EADDRINUSE` just means a board is
already up — reuse that URL. If the page says "UI not built", run
`bun run build:web` then **restart `serve`** (it snapshots assets at boot, so a
refresh alone won't pick up a rebuild).

**Reading state — pass `--json` whenever you'll parse output** (it's
human-formatted by default and never auto-switches):

- `tasks export --json` — the whole store in one call (every task + body +
  acceptance criteria + forward/reverse deps + HEAD sha). Use to plan or re-orient
  after a context reset.
- `tasks summary --json` — a compact digest (counts, recent, stale). Use for
  "where do things stand?".

**IDs.** Short id (the integer you type) vs UUID (stable, internal). Both work
anywhere a command takes `<id|uuid>`.

## Secondary: run the board for the user

Translate intent to commands, confirm what you did, change no code.

- "what's blocking X?" → `tasks export --json`, read X's forward deps, name the
  ones not yet in `done`.
- "add a task to do X, needs Y first" → `tasks new "X" --deps <Y-id>` (find Y via
  `tasks list --json`).
- "show me the board" → `tasks serve` in the background, hand over the URL; or
  `tasks board` for the terminal.
- "what's next?" → `tasks next` (no `--unattended` — a human is picking up).

## When a command refuses

Read the code, then:

| Code | Fix |
|---|---|
| `STORE_DIRTY` | `tasks doctor` shows the diff; `tasks doctor --clean` stashes it (prints a recover line); retry. |
| `CYCLE_DETECTED` | A `link` would loop the graph — drop the closing edge or rethink the ordering. |
| `UNKNOWN_UUID` | A dep points at an unresolvable task (archived ones DO resolve, so it's a bogus/stale id). If it's the task you touched, you used a wrong id. If it names a *different* task, that one carries a dangling edge: `tasks unlink <that-task> --depends-on <uuid>` strips it (unlink doesn't follow the target). Last resort: `tasks edit <that-task>` (exempt from the dirty guard) to clear `deps:`. |
| `DEP_EXISTS` | `rm` target has dependents — repoint them, or `tasks rm <id> --force` (strips refs, prints what it touched). |
| `NO_READY_TASK` | Nothing unblocked in `ready` — move a workable task there, or you're done. |
| `NOT_INITIALIZED` | `tasks init` first. |
| `NOTHING_TO_UNDO` | At the seed commit; ignore. |
| `FLOCK_MISSING` | Install `flock` (the error prints the hint). |

Escape hatches: `tasks edit <id> --abort` resets a half-finished edit to HEAD;
`tasks undo` reverts the last mutation as a new commit (reversible by running it
again).

## Why

Every change is a git commit, so progress is durable across crashes and context
resets, diffable, and revertable. Tracking turns "I think I finished the
migration" into "3 of 4 slices done, the 4th in review" — for you and whoever's
watching.
