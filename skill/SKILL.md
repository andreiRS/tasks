---
name: tasks
description: >-
  Track multi-step work as it happens using the `tasks` CLI (a git-backed kanban
  for human + agent task management). Reach for this whenever you take on a job
  with three or more steps or any ordering between steps — a feature with
  impl-then-tests, a refactor touching several files, a migration, a bug hunt
  with a fix that depends on a repro. Create the card for a slice before you start
  it (not after), wire up the dependencies, and move tasks across columns as you
  go, so the work survives a dropped session and the user can watch it live on a
  board. Also use it when the
  user talks to the board directly: "add a task", "what's blocking X", "show me
  the board", "what should I pick up next". Do NOT spin it up for a single
  one-shot edit — the bookkeeping isn't worth it there.
---

# tasks

`tasks` is a single-binary CLI that stores each task as a markdown file with YAML
frontmatter in a per-project git repo. Every mutation is one git commit, so the
board doubles as an audit log. Tasks flow through six columns:

```
backlog → ready → doing → blocked → review → done
```

You drive it two ways. The **primary** use is tracking your *own* multi-step work
while you do an engineering job. The secondary use is acting as the user's
front end when they talk to the board directly. Both are below.

## Source of truth

This file teaches the *workflow and judgment*. It does not restate every flag,
because the binary already documents itself and flags drift over time. For the
exact command surface, run `tasks --help` and `tasks <command> --help`, or read
`docs/commands.md` in the tasks repo. When a command rejects your input, the
error message and code tell you what to fix — read it before guessing.

If the `tasks` binary isn't on `PATH`, it's the project in this repo: run it with
`bun run src/cli.ts ...` from the tasks checkout instead of `tasks ...`.

Run every `tasks` command from inside the repo you're tracking. The store is keyed
by the **nearest `.git` ancestor of your cwd** (not the raw cwd), so any directory
within that repo is fine, but if you `cd` *out* of it (say into `/tmp` to run a
scratch test) the CLI silently falls back to a different store and your board looks
empty. If a read comes back unexpectedly empty, check where you are first.

## Primary: track your own work

### When to start

Start tracking when the job you've been handed is **three or more steps, or has
any ordering between steps**. A two-line edit doesn't need a board; a feature
that's "write the migration, then the model, then the endpoint, then tests" does.
The point is to give long work a memory: if the session dies, the board (and its
git history) says exactly what's done and what's left.

### Offer the live board, once

The first time you start tracking in a session, tell the user they can watch:

```sh
tasks init          # serve refuses (NOT_INITIALIZED) without this
tasks serve         # boots http://127.0.0.1:4317, leave it running in the background
```

Run `serve` in the background so it doesn't block your work, and say one line like
"Tracking this on a board — watch it live at http://127.0.0.1:4317." Say it once,
not on every task. If the user clearly doesn't care, skip the board and just track.

Two things to know about `serve`:

- **The web UI must be built.** From a `tasks` installed via `bun link` (or run
  from source), the board UI only appears after a one-time `bun run build:web` in
  the tasks repo; `serve` then auto-serves it. If the UI isn't built, opening the
  URL shows a short page that says exactly that, and the JSON API under `/api`
  still works. If the user reports a JSON error or a "UI not built" page, tell
  them to run `bun run build:web` (or use the compiled binary via
  `bun run build:binary`), then **restart `serve`**. `serve` snapshots the built
  assets into memory once at boot, so a rebuild has no effect on a running board
  until you stop and restart it — a browser refresh alone won't pick it up.
- **`EADDRINUSE` is good news, not an error.** It means a board is already running
  on that port — just point the user at the existing URL. Use `--port 0` (or
  another port) only if you truly need a second one.

### The loop

**Card first, then work.** The moment you know what the next slice is, create its
card and move it to `doing` *before* you make the first edit or run the first
command for it — not after, not at the end of the job. The board exists to mirror
what you're doing *right now*; if you code first and log later, it can't, and a
session that dies mid-slice loses the work with no trace. If you catch yourself
editing with nothing in `doing`, stop and create the card before the next change.
The cost is one command; the payoff is a board that's always true.

Think of each task as a slice of the job. A good slice is something you'd want to
see as a single line on a board: "Add rate-limit middleware", not "type a
function". Create them up front when you can see the shape of the work, or as you
go when you can't.

```sh
# Create a slice. Capture the short id from the "task: new #<id>" line it prints —
# you'll use that id for every later command. --unattended marks it as agent work
# so `tasks next --unattended` will pick it up.
tasks new "Add rate-limit middleware" --unattended

# Express ordering: tests can't start until the middleware exists.
tasks new "Tests for rate limiter" --unattended --deps 4   # 4 = middleware's id
# (or after the fact: tasks link <tests-id> --depends-on <middleware-id>)

# Mark a slice workable, then pull the next unblocked one.
tasks mv 4 ready
tasks next --unattended        # prints the oldest ready task whose deps are all done

# Move it across the board as you work it.
tasks mv 4 doing
# ...do the actual work...
tasks mv 4 review              # if it needs checking, e.g. tests or review
tasks mv 4 done                # when it's truly finished
```

`mv` between any two columns is allowed — the CLI never forces deps to be done
before a move. Use `blocked` when something external stalls a task (waiting on an
answer, a flaky dependency), so the board reflects reality.

You don't have to micromanage every column. A linear job can be just
`new → mv doing → mv done`. The `ready`/`next` machinery earns its keep when there
are real dependencies and you want the tool to tell you what's unblocked.

### Reading state (always with `--json`)

Output is human-formatted by default and does **not** switch to JSON on its own.
Whenever you're going to *parse* output, pass `--json`. Two reads are built for
agents:

- `tasks export --json` — one call dumps the whole live store: every task's
  frontmatter, body, parsed acceptance criteria, forward + reverse deps, and the
  HEAD commit sha. Use this to plan or re-orient after a context reset.
- `tasks summary --json` — a compact digest (per-column counts, the 10 most
  recently touched tasks, and stale in-progress tasks). Use this for "where do
  things stand right now?" without dumping everything.

### Keep ids straight

Tasks have a short id (small integer, what you type) and a UUID (stable, what
deps store internally). Capture the short id from `new`'s output and reuse it.
Both forms work anywhere a command takes `<id|uuid>`.

## Secondary: the user drives the board

When the user talks about the board directly, translate their intent to commands
and confirm what you did. No code changes happen here.

**Example — "what's blocking the auth refactor?"**
Run `tasks export --json`, find the auth task, read its forward deps, and report
the ones not yet in `done`. Name the blockers by id and title.

**Example — "add a task to fix the flaky login test, it needs the new fixtures first"**
`tasks new "Fix flaky login test" --deps <fixtures-id>` (find the fixtures id via
`tasks list --json` first if you don't have it).

**Example — "show me the board"**
`tasks init` if needed, then `tasks serve` in the background, and hand over the
URL. If they want it in the terminal instead, `tasks board`.

**Example — "what should I work on next?"**
`tasks next` (drop `--unattended` — a human is picking up).

## When a command refuses: recovery

Mutations take a lock, then refuse if the store has uncommitted changes or the
write would break an invariant. Read the code, then:

| Code | What happened | Do this |
|---|---|---|
| `STORE_DIRTY` | The store's git tree has uncommitted changes from outside a normal mutation. | `tasks doctor` to see the diff, then `tasks doctor --clean` (stashes it, prints a stash ref you can `git stash pop` later) and retry. |
| `CYCLE_DETECTED` | A `link` would create a dependency loop. | Drop the edge that closes the loop, or rethink the ordering — the graph must stay acyclic. |
| `UNKNOWN_UUID` | A dep points at a task the graph validator can't resolve at all. The error names both uuids: the task carrying the bad edge and the missing target. Archived tasks **do** resolve (they count as Complete terminal deps), so this fires only on a genuinely bogus id or a stale edge to a fully-deleted task. | If it's the task you just touched, you used a stale or wrong id (check `tasks list --json`). If it names a *different* task, that task carries a dangling edge to a deleted task that's blocking all graph mutations. `tasks unlink <that-task> --depends-on <uuid>` strips it: `unlink` removes a reference without following it, so it drops an edge to an archived or fully-deleted target. If even that can't, `tasks edit <that-task>` (exempt from the dirty guard) clears the bad dep, e.g. a scripted `$EDITOR` that rewrites the `deps:` line to `deps: []`, then retry. |
| `DEP_EXISTS` | You tried to `rm` a task others depend on. | Remove or repoint the dependents first, or `tasks rm <id> --force` to delete and strip the dangling refs (it prints what it touched). |
| `NO_READY_TASK` | `tasks next` found nothing unblocked. | Everything's either done, still has unfinished deps, or not in `ready`. Move a workable task to `ready`, or you're done. |
| `NOT_INITIALIZED` | `serve` (or a read) ran before the store existed. | `tasks init` first. |
| `NOTHING_TO_UNDO` | `tasks undo` at the seed commit. | Nothing to revert; ignore. |
| `FLOCK_MISSING` | `flock` isn't on `PATH`. | Install it (the error prints the hint); the store can't lock safely without it. |

Two recovery tools worth knowing:

- `tasks edit <id> --abort` resets a half-finished edit back to HEAD. `edit` is
  the one command exempt from the dirty-tree guard, so it's your escape hatch.
- `tasks undo` reverts the last mutation as a *new* commit (no history rewrite),
  and is itself reversible by running it again. Good for "oops, wrong move".

## Why this exists

The board isn't busywork. Because every change is a git commit in a real repo,
your progress is durable across crashes and context resets, diffable, and
revertable. Tracking as you go turns "I think I finished the migration" into "the
board says 3 of 4 slices are in done and the fourth is in review" — for both you
and the person watching.
