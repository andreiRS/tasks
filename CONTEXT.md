# tasks

A single-binary CLI that captures, tracks, and hands off work between a human and Claude Code agents. State lives as markdown files in a per-project git repository, so every change is a reviewable commit and the same CLI surface is used by humans and agents.

This file is a glossary. It defines the canonical terms used across the codebase, docs, commit messages, and agent prompts. Implementation details belong in the code or in `docs/adr/`, not here.

## Language

**Task**:
A single unit of work, represented as one markdown file with YAML frontmatter and a free-form body. Tasks are flat, never nested.
_Avoid_: Issue, ticket, item, card, todo.

**Subtask**:
Not a concept in this system. A complex unit of work is decomposed into multiple Tasks linked by Dependencies.
_Avoid_: child task, nested task.

**Project**:
The working directory rooted at the nearest ancestor `.git/` directory (falling back to `pwd`). One Project, one Store. The Project root is resolved per invocation from the current working directory.
_Avoid_: workspace, repo (ambiguous with the Store's git repo), folder.

**Store**:
The per-Project git repository under `$TASKS_HOME/projects/<encoded-path>/` (where `TASKS_HOME` defaults to `~/.tasks`) that holds every Task file plus its Meta (`meta.yaml`). The Store is the system of record; the CLI is the only sanctioned writer.
_Avoid_: database, backend, data dir.

**Meta** (also: `meta.yaml`):
The per-Store YAML file that holds Store-wide state, currently just `next_id` for Short ID allocation. Read and written by the Validator inside the Lock so allocation can never race.
_Avoid_: config, manifest, store.yaml.

**Column**:
One of the six fixed status buckets: `backlog`, `ready`, `doing`, `blocked`, `review`, `done`. A Task's Column is encoded by the directory the file lives in. Moving Columns is a Transition (a `git mv`). The Archive directory is **not** a Column. The `blocked` Column is a place a caller deliberately moves a Task to; it is **not** the same as having an Unresolved Blocker, which is derived from `deps` and can hold in any Column (see **Unresolved Blocker**).
_Avoid_: status, state, lane, stage.

**Archive**:
A sibling directory `archive/` inside the Store that holds Tasks the caller has explicitly retired from the live workflow. Not a Column: Transitions never target it, the only way in is `tasks archive`, and `list`/`board`/`next` skip it by default. Archived Tasks still count as Complete for blocking purposes, so dep resolution scans `archive/` alongside `done/`. See `docs/adr/0010-archive-as-sibling-directory.md`.
_Avoid_: archived column, archive status, trash, deleted.

**Transition**:
Any move of a Task from one Column to another. All Column-to-Column moves are legal; the Validator does not enforce a workflow (per `docs/adr/0005-open-transitions.md`). Callers are free to move a Task `done → doing`, `blocked → ready`, and so on.
_Avoid_: status change, workflow step, promote, demote.

**Dependency** (also: **Dep**):
A directed edge `A → B` meaning "Task A depends on Task B" (equivalently "B blocks A"). Stored as a UUID in the dependent Task's `deps` frontmatter list. Always references the UUID, never the Short ID.
_Avoid_: blocker (ambiguous direction), parent/child, link (used for the command).

**DAG**:
The directed acyclic graph formed by all Dependencies across all Tasks in a Store. The Validator rejects any write that would introduce a cycle or reference an unknown UUID.
_Avoid_: graph (too generic), tree (it isn't one).

**Forward dep**:
A Task this Task depends on. Listed in `deps`.

**Reverse dep**:
A Task that depends on this Task. Computed by scanning the Store.
_Avoid_: blocker, blocking, dependent (overloaded with the noun "dependent" meaning a Task with deps).

**Complete (for blocking purposes)**:
A Dependency is satisfied only when the depended-on Task is in `done`. `review` does not count.
_Avoid_: finished, closed, resolved.

**Unresolved Blocker**:
A declared Dependency whose depended-on Task is not yet in `done`. A Task has unresolved blockers when at least one entry in its `deps` list points to a Task in any Column other than `done`. This is **orthogonal to the `blocked` Column**: a Task in `ready` or `doing` can have unresolved blockers, and a Task sitting in the `blocked` Column need not have any deps at all. The `list` and `board` commands surface unresolved blockers as a `[blocked by #N,#M]` marker, and `serve` surfaces the same fact regardless of the Column the Task occupies; `tasks next` hard-filters them out.
_Avoid_: open blocker, active dep, incomplete dep.

**Short ID**:
A small positive integer scoped to a single Store, monotonically increasing and never reused. Allocated from `meta.yaml`'s `next_id`. For humans typing on the CLI.
_Avoid_: number, index, ID (ambiguous with UUID).

**UUID**:
The v4 UUID assigned to each Task at creation, globally stable. Used for all internal references (Dependencies, cross-system integrations). Agents use UUIDs by default; humans use Short IDs.
_Avoid_: GUID, hash, key.

**Frontmatter**:
The YAML block at the top of a Task file. Required keys: `id`, `uuid`, `title`, `created_at`, `updated_at`. Optional with defaults: `deps` (`[]`), `attendance` (`attended`), `effort` (`medium`). Defaults for `attendance` and `effort` are written explicitly to disk by `tasks new` so files are self-describing in `$EDITOR`. Read and written via the `yaml` library's `Document` API to preserve ordering and quoting style.
_Avoid_: header, metadata.

**Title**:
The required `title` Frontmatter field. Non-empty after trim, single line (no embedded newlines), max 200 characters. The Validator rejects violations with `INVALID_TITLE`.
_Avoid_: name, summary, subject.

**Timestamps**:
The required `created_at` and `updated_at` Frontmatter fields. `created_at` is set once at Task creation and is immutable. `updated_at` is rewritten by every Mutating command that touches the Task, including Transitions. Cutoff filters on `updated_at`; Next orders by `created_at`.
_Avoid_: dates, times, mtime, ctime.

**Body**:
The markdown content of a Task file below the frontmatter. Free-form prose, except for the conventional `## Acceptance Criteria` section.
_Avoid_: description, notes, content (ambiguous with the whole file).

**Acceptance Criteria**:
The content of the `## Acceptance Criteria` section in the Body. Parsed by a hand-rolled, fence-aware, case-insensitive scanner and exposed as a top-level `acceptance_criteria` field on `--json` reads. Defines what "done" means for the Task.
_Avoid_: AC (only spelled out), spec, requirements.

**Attendance**:
A Frontmatter enum, either `attended` or `unattended`, that gates agent Pickup. `unattended` means an agent may pick this Task up; `attended` (the default) excludes it from agent Pickup. Settable on `tasks new --unattended` and on `tasks set --attendance`. Invalid values are rejected with `INVALID_ATTENDANCE`.
_Avoid_: agent_ready, human_in_loop, assignable, manual.

**Pickup**:
The act of a caller (Human or Agent) taking ownership of a Task by moving it to `doing`. Eligibility is gated by Attendance: `unattended` Tasks are eligible for Agent Pickup, `attended` Tasks are not. Humans Pickup regardless of Attendance.
_Avoid_: assign, claim, take, grab.

**Effort**:
A Frontmatter enum, either `low`, `medium`, or `high`, capturing the expected cognitive or model resource needed to pick up this Task. Pure metadata in v1: stored, surfaced, and filterable, but the CLI does not act on it (no automatic model selection, no ordering bias). Defaults to `medium`. Invalid values are rejected with `INVALID_EFFORT`.
_Avoid_: size, weight, complexity, points.

**Next**:
The Task surfaced by `tasks next`: in `ready`, all forward Deps Complete, oldest `created_at` wins. No Attendance filter by default, so a human sees the oldest ready, unblocked Task regardless of pickup eligibility. Agents pass `--unattended` (shorthand for `--attendance unattended`) to restrict to safe-for-agent work. Exits non-zero with `NO_READY_TASK` if no candidate exists.
_Avoid_: queue, pending.

**Validator**:
The component that enforces invariants on every mutating CLI call: required Frontmatter fields, title constraints, DAG rules (cycle detection, unknown UUID rejection). Runs inside the lock, never bypassable from the CLI surface.
_Avoid_: linter, checker, schema.

**Renderer**:
The component that turns Tasks into either human-facing text (with ANSI styling) or JSON. Owns `--no-color` / `NO_COLOR` handling so every read command inherits the contract.
_Avoid_: formatter, printer, view.

**JSON mode**:
The machine-readable output contract enabled by passing `--json` to any command. On success: `{ "ok": true, ... }` to stdout, exit 0. On failure: the Error envelope to stderr, non-zero exit. Both shapes are stable contracts; new fields may be added, existing fields never change meaning.
_Avoid_: machine output, structured output, `--json` flag.

**Error envelope**:
The shape returned on stderr when a command run in JSON mode fails: `{ "ok": false, "error": { "code", "message", "details" } }`. `code` is drawn from a fixed enum (see README). The envelope shape is a stable contract; new codes may be added, the shape never changes.
_Avoid_: error message, exception, failure object.

**Cutoff**:
The default 7-day window applied to `done` Tasks in `list` and `board`: Tasks whose `updated_at` is older are hidden unless `--all` or `--since <duration>` is passed.
_Avoid_: filter, expiry.

**Clock**:
The single seam (`src/clock.ts`: `nowMs()` / `nowISO()`) through which every "now" is read. Honors the `TASKS_NOW` ISO-8601 environment override and falls back to the real system clock, so the Cutoff window and Timestamps are deterministic under test. See ADR-0015.
_Avoid_: `Date.now()`, `new Date()` (never read wall-clock time directly).

**Export**:
The whole-Store JSON dump emitted by `tasks export --json`, intended as a single-call read for agents. Includes every live-Column Task (frontmatter + Body + parsed Acceptance Criteria), the reverse-Dep index, the Store HEAD commit SHA, and the schema version. Archived Tasks are excluded by default; any Archived Task referenced as a Dep by a live Task is included as an Archive Stub. Ordered by Column (fixed order), then by `created_at` ascending. `--include-archived` opts the full Archive in.
_Avoid_: dump, snapshot, backup.

**Archive Stub**:
The minimal Task record (`{ id, uuid, title, column: "archive", complete: true }`, no Body, no Acceptance Criteria) emitted by Export for any Archived Task that is still referenced as a Dep by a live Task. Preserves Dep-graph completeness without dragging Archive content into the payload.
_Avoid_: archived stub, dep stub, ghost.

**Summary**:
The compact Store digest emitted by `tasks summary --json`: per-Column counts, the last 10 Tasks by `updated_at` ("recent"), and live-Column Tasks (`doing`/`blocked`/`review`) untouched for 14+ days ("stale"). A separate command from Export, with its own envelope (no `tasks` array). Thresholds overridable via `--recent N` and `--stale <duration>`.
_Avoid_: digest, overview, status.

**Mutating command**:
A CLI invocation that writes to the Store. Takes the Lock, runs the Validator, and produces exactly one git commit on success. May trigger Auto-init. Refuses to run against a Dirty tree, except for `tasks edit`.
_Avoid_: write command, mutator, mutation.

**Read command**:
A CLI invocation that only reads the Store. Does not take the Lock, does not run the Validator, does not commit, and never triggers Auto-init. Inherits `--no-color` / `NO_COLOR` and JSON mode handling from the Renderer.
_Avoid_: query command, lookup, viewer.

**Dirty tree**:
The Store's git working tree has uncommitted changes. Every Mutating command except `tasks edit` refuses with `STORE_DIRTY` when the tree is dirty; `tasks edit --abort` is the recovery path.
_Avoid_: pending changes, unstaged.

**Edit session**:
The flow opened by `tasks edit`: the CLI checks the Task out into `$EDITOR`, leaves the Store's working tree dirty until the user saves and exits, and commits on success. `tasks edit --abort` discards the in-progress change and restores a clean tree. `edit` is the sole Mutating command exempt from the `STORE_DIRTY` check.
_Avoid_: editing, edit mode, edit flow.

**Lock**:
The exclusive `flock(1)` taken on `<store>/.tasks-lock` for the duration of any mutating command. Serializes ID allocation, validation, file writes, and the git commit as one critical section. Reads do not take the Lock.
_Avoid_: mutex, semaphore.

**Auto-init**:
The behavior where the first mutating command in a fresh Project creates the Store directory, runs `git init`, makes an empty initial commit, creates all six Column directories, and prints a stderr notice. Read commands never Auto-init.
_Avoid_: bootstrap, setup.

**Path encoding**:
The reversible scheme that turns an absolute Project root path into a Store directory name: literal `-` is doubled to `--`, then `/` is replaced with `-`. Mirrors Claude Code's per-project state convention by spec, not by code coupling.
_Avoid_: slug, hash (it is neither).

**Agent / Human**:
The two kinds of CLI caller. The CLI does not distinguish them at runtime; the model carries `Attendance` to signal pickup eligibility, but every mutation goes through the same Validator and produces a normal git commit. Convention: humans use Short IDs and let `Attendance` default to `attended`; agents pass UUIDs and `--unattended` on `tasks next` to restrict to safe-for-agent work.
_Avoid_: user, actor, bot.
