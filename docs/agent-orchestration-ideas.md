# Agent Orchestration Ideas

Brainstorm doc, not a spec. Each idea here is a candidate for a future iteration
focused on making the tasks CLI a better tool for AI agents (and the humans
collaborating with them).

Source material:
- Anthropic, "Harness design for long-running apps"
- Anthropic, "Effective harnesses for long-running agents"
- Current `PRD.md`, `CONTEXT.md`, `docs/adr/`

Items are ordered by estimated agent-side value (most → least). Each carries a
short rationale, sketch, and the open questions worth resolving before code.

**Status (as of v0.1.0).** Some of the highest-value items have since shipped and
are kept here only for context — the open ideas are #2, #3, #6, #7, #8, #9, #10.

- ✅ **#1** — shipped as `tasks export --json` plus a separate `tasks summary --json`
  command (the `--summary` variant became its own command).
- 🟡 **#4** — partially shipped: `export`, `show`, and `next` expose
  `acceptance_criteria` as a parsed **string**. The structured
  `[{ text, satisfied }]` array proposed below is still open.
- ✅ **#5** — shipped: `tasks next --json` returns the full task (frontmatter +
  body + parsed `acceptance_criteria`) plus `deps_out` / `deps_in` edges.

---

## 1. `tasks export --json` (with `--summary`) — ✅ shipped

**Why it matters to an agent.** Today, learning the state of a store costs
multiple round-trips (`list`, then `show` for each interesting task). One
structured read collapses that to a single tool call. The `--summary` variant
serves the "session start, what's going on?" use case without dumping the whole
store into context.

**Sketch.**
- `tasks export --json` returns: every task (frontmatter + body), columns, dep
  graph (forward and reverse), HEAD commit SHA, schema version.
- `tasks export --summary --json` returns: per-column counts, recently touched
  (last N commits), currently blocked, stale (no activity > X days), HEAD SHA.
- Optional: `--fields a,b,c` projection, `--column foo` filter, `--since <ref>`.

**Open questions.**
- Default shape of `--summary` (what counts as "recent"? "stale"?).
- Should body content be included by default or opt-in via `--include-body`?
  Bodies dominate payload size.
- Stable ordering for deterministic diffs across exports.

**Related.** Reuses validator output for any integrity warnings inline.

---

## 2. `tasks batch <file.json>`

**Why it matters to an agent.** Lets the agent express a multi-step intent as
one transaction. The validator runs once over the post-batch state, so the
store can never land in a partially-applied broken shape. Git history records
one commit per logical intent rather than N micro-mutations.

**Sketch.**
- Input: a JSON document listing operations (create, move, edit, link, unlink,
  set, rm, archive, comment-on-body?).
- Atomicity: validate the post-batch state; if it fails, write nothing.
- One git commit per batch, message synthesized from the ops (or supplied by
  the caller via `--message`).
- Output: JSON with the resulting IDs/UUIDs and per-op outcomes.

**Symbolic cross-references (load-bearing detail).** When an agent generates
N tasks in one batch where later ones depend on earlier ones, the later tasks
can't name a UUID that doesn't exist yet. Batch input needs symbolic refs
that resolve in-transaction:

```json
{ "ops": [
    { "op": "new", "ref": "@slice-1", "title": "..." },
    { "op": "new", "ref": "@slice-2", "title": "...", "deps": ["@slice-1"] }
] }
```

Without this, "publish a sliced PRD in one call" doesn't actually work and
the agent falls back to N+M calls (create all, then patch deps).

**Open questions.**
- One commit vs. per-op commits. Project convention is "one commit per green
  state"; a batch is one logical green state, so one commit feels correct. ADR
  worth writing.
- Op naming and shape. Mirror existing CLI verbs, or introduce a new op
  vocabulary?
- Should batch accept the same shape `export` emits (round-trippable)? Probably
  no: conflates state with operations and invites subtle bugs.
- Symbolic ref syntax (`@name`, `$name`, `{{name}}`). Lean: `@name` — short,
  unambiguous, doesn't collide with short IDs which are numeric.
- Optimistic concurrency: see HEAD-SHA guard in cross-cutting section.

**Related.** Depends on #7 (schema) for input validation. Pairs with #3
(dry-run).

---

## 3. `tasks batch --dry-run`

**Why it matters to an agent.** Preview the validator result and the diff
without committing. Lets the agent think-then-act on confidence instead of
try-then-rollback. Equivalent of "compile before run" at the CLI boundary.

**Sketch.**
- Same input as `tasks batch`.
- Output: validator result (pass/fail with codes), and a structured diff of
  what would change (created UUIDs, moved tasks, edited fields).
- No commit, no lock acquisition required (or acquired briefly and released).

**Open questions.**
- Does dry-run still take the flock to guarantee the preview matches what an
  immediate real run would do? Probably yes for correctness, no for speed.
- Output shape: structured diff vs. unified-diff text. Structured is
  agent-friendlier.

---

## 4. Structured acceptance criteria in `export` — 🟡 partially shipped (string, not structured)

**Why it matters to an agent.** ADR-0007 puts acceptance criteria in the
markdown body; `src/acceptance.ts` already parses them. Today the parsed form
isn't exposed. Surfacing AC as a structured array per task unlocks the
**evaluator-separation pattern** the articles call the strongest quality
lever: one agent generates, a second agent (or a later session) mechanically
checks AC against the diff.

**Sketch.**
- `tasks export --json` includes per task:
  `acceptance: [{ text, satisfied: bool, line?: number }, ...]`
- `tasks show <id> --json` includes the same.
- No new commands. Re-uses the existing parser.

**Companion: structured user stories.** Same idea, second field. If
`user_stories: []` were first-class alongside AC, `tasks show` could render
both nicely, and a future `promote` (see #8) could map them cleanly to
upstream tracker checklist syntax.

**Open questions.**
- What does "satisfied" mean here? AC are markdown checkboxes today; satisfied
  = checked. Anything more is feature creep.
- Should AC be emitted even when the body has none (empty array vs. omitted)?
  Empty array is more predictable for consumers.
- Where do user stories live: frontmatter, parsed from body, or both? Parsing
  from body keeps the markdown source canonical; frontmatter is easier for
  agents to write reliably. Lean: parse from body, mirror in JSON output.

---

## 5. `tasks next` self-sufficient (`--json` returns full context) — ✅ shipped

**Why it matters to an agent.** Story 26 already exists. Today `next` prints a
short summary. If `next --json` returned the full body, parsed AC, and the dep
chain (with their statuses), an agent could pick up work from a single tool
call instead of `next` → `show` → maybe `show <dep>`. Pure round-trip
reduction, no new concepts.

**Sketch.**
- Default human output unchanged.
- `--json` payload includes: task frontmatter, body, parsed AC (#4), and dep
  chain summary (`{ id, title, column }` for each dependency).
- Optional: `--include-blockers` to also include reverse edges (tasks blocked
  by this one).

**Open questions.**
- Context-size discipline: full body might be large. Same question as in #1.
  Probably acceptable here because the agent is about to start work on this
  exact task.

---

## 6. `tasks doctor --validate`

**Why it matters to an agent.** Session-start integrity check. Tells the agent
up front whether the store is coherent (no cycles, no dangling deps, no
malformed frontmatter) so it doesn't begin work on a broken graph and
misattribute the failure. The articles harp on "verification testing at
session start" as the practice that catches the most undocumented bugs.

**Sketch.**
- Extends the existing `tasks doctor` (currently scoped to filesystem and git
  health).
- `--validate` runs the validator across the whole store and reports findings
  by code (`CYCLE_DETECTED`, `UNKNOWN_UUID`, ...).
- `--json` payload merges existing diagnostics with a `validation: {...}`
  block.

**Open questions.**
- Default behavior of bare `tasks doctor`: should it validate by default once
  this is available? Lean: no, validation is opt-in for cost reasons; document
  the recipe (#10 in the broader list) so agents know to ask for it.
- Exit code semantics. Today doctor always exits 0. Should `--validate`
  produce a non-zero exit when issues exist? Probably yes, with a flag to
  suppress for tooling that wants the report regardless.

---

## 7. `tasks schema <export|batch>`

**Why it matters to an agent.** Documentation drifts; code-derived schemas
can't. A machine-readable shape lets the agent construct valid `batch`
payloads on the first try and self-validate before calling. Doubles as the
backing validator for `batch` itself, so there is one source of truth across
runtime parsing, help, and external tooling.

**Sketch.**
- Pick a schema library (Zod, TypeBox, hand-rolled TS + JSON Schema generator).
  Define the batch input shape and the export output shape once.
- `tasks batch` parses input against the schema at runtime.
- `tasks schema batch` and `tasks schema export` print the JSON Schema.

**Open questions.**
- Library choice. Bun-friendly, small dependency surface.
- Schema versioning. Include `$id` and a version string in the output payload
  so external consumers can detect breaking changes.
- Whether to also publish a TypeScript type bundle alongside, for human
  consumers writing integrations.

---

---

## 8. Parent / epic field

**Why it matters.** When an agent breaks a PRD into N slices, today they're
held together only by a shared topic in titles or a chain of `depends-on`
edges. There's no first-class "these belong to one feature" relationship.
A `parent:` frontmatter field plus `tasks list --parent <id>` gives you the
whole breakdown back in one view.

**Open question: how is "parent" different from a dependency?**

This is the part to think through carefully before implementing. They look
similar (both are edges between tasks) but they encode different things:

- **Dependency** is a *sequencing constraint.* "B can't start until A is
  done." Forms a DAG that gates work. The validator already enforces no
  cycles and unblocks downstream when upstream is done. `tasks next` walks
  this graph to find ready work.
- **Parent / epic** is a *containment relationship.* "These N slices together
  make up feature F." Forms a tree, not a DAG. Children don't need to be
  sequential with each other; they share a *reason for existing*, not an
  *order of execution*.

Concrete differences that fall out of that distinction:

| Concern              | Dependency                             | Parent                                       |
|----------------------|----------------------------------------|----------------------------------------------|
| Shape                | DAG, many-to-many                      | Tree, each child has at most one parent      |
| Cardinality          | A task can have many deps              | A task has one parent (or none)              |
| Affects "ready"?     | Yes — gates `tasks next`               | No — parent status doesn't gate children     |
| Delete behavior      | Removing target may leave dangling dep | Deleting parent with live children: warn/refuse? |
| Primary use          | Scheduling: what's unblocked           | Navigation: what's this feature's progress   |
| Render               | "blocked by #3, #5"                    | "part of #12: Auth rewrite"                  |

Could parent be modeled as "just a special dep + a label"? Probably no, for
two reasons: (a) parents shouldn't gate `next` (you can work on slice 2
without slice 1 being done), and (b) the tree shape lets you ask "show me
the whole feature" in one call, which a flat tag can't.

Could it instead be modeled as a separate "label" or "milestone"? That's
closer but loses the asymmetry: a parent task can itself be worked on,
moved, archived. An epic is a task that happens to contain others.

**Sketch (tentative).**
- New optional frontmatter field: `parent: <uuid>`.
- Validator: parent must exist, cycle prevention (a task can't be its own
  ancestor), can't delete a parent with live children (or use `--force`).
- `tasks list --parent <id>` filters to children of an epic.
- `tasks show <id>` for a parent task includes a children summary block.

**Defer until.** We have a concrete agent workflow that wants this and we've
decided the containment-vs-sequencing model above is right.

---

## 9. Source provenance

**Why it matters.** Six weeks after a task is created, neither the human nor
a fresh agent can answer "why does this exist?" A `source:` frontmatter
field pointing at the originating PRD, plan, or URL fixes that for the cost
of one field.

**Sketch.**
- Optional `source:` field in frontmatter. Free-form string: file path,
  URL, or short tag like `prd:auth-rewrite`.
- Surfaced in `tasks show` and in `export` JSON.
- Optional convenience: `tasks new --source <ref>` flag, and `batch` accepts
  it per-op.

**Open questions.**
- Should `source` be validated (e.g., file exists, URL parses) or fully
  free-form? Free-form is cheaper and matches the markdown ethos.
- Multiple sources per task? Probably not; if a task spans two PRDs, that's a
  task structure problem, not a metadata problem.

---

## 10. Promote to upstream tracker

**Why it matters.** Lets agents and humans iterate on slicing locally
(fast, private, cheap, revertible) and only push to the team tracker once
the breakdown has settled. Removes the friction that currently pushes people
to either skip the local stage or skip the upstream stage.

This is the largest scope item in the list. It changes what the tasks app
*is*: not just a local issue tracker, but a staging ground for upstream
work. Worth its own design doc once we commit to the direction.

**Sketch.**
- `tasks promote <id> --to gh|linear` creates the upstream issue, copies the
  body (mapping AC and user stories to checklist syntax per provider), and
  stores the external ID back on the task in an `external:` block:
  ```yaml
  external:
    provider: gh
    repo: owner/name
    number: 142
    url: https://github.com/owner/name/issues/142
    pushed_at: 2026-05-28T...Z
  ```
- v1 is one-way push only. Bidirectional sync (status mirror, comment relay)
  is a much bigger rabbit hole and probably never worth it.
- Auth: `gh` CLI handles GitHub; Linear needs a token via env var or config.

**Open questions.**
- Re-promote semantics. If a task is promoted then edited locally, what does
  the second `promote` do? Update upstream? Refuse? Probably refuse without
  `--update`, and `--update` updates body but never status (status drift
  between local and upstream is a feature, not a bug).
- Body translation. Provider markdown dialects differ; AC checkboxes mostly
  port cleanly, headings sometimes don't. Worth a per-provider adapter.
- Which providers in v1? Lean: `gh` only, since it's free-via-CLI and covers
  the common case. Add Linear when there's a real ask.

**Defer until.** We've validated demand and decided whether this is a
*tasks* feature or a *separate tool that consumes the tasks JSON export.*
Argument for the latter: keeps tasks lean and means provider integrations
don't bloat the core binary.

---

## Cross-cutting considerations to revisit per-idea

- **Atomicity vs. commit granularity.** Project rule is "one commit per green
  state." A batch is one logical green state. Write the ADR before coding.
- **Context-size discipline.** Full bodies in JSON dominate payload size at
  scale. Decide per-command whether body is opt-in or default.
- **Optimistic concurrency.** A `expected_head` field in batch input would let
  multi-actor scenarios fail loudly instead of silently stomping. Not urgent
  in single-agent sessions; design in so it can be activated later.
- **Iterative simplification.** Each new flag or command encodes an assumption
  about what the agent can't do. As models improve, revisit whether all of
  these are still load-bearing.

## Suggested order if implementing

1. #7 (schema infrastructure) — unblocks #2 cleanly.
2. #1 (export) — biggest single-call value, no dependencies.
3. #9 (source provenance) — trivial frontmatter addition, surfaces in #1 for free.
4. #4 (AC in export) — small change to #1's payload.
5. #5 (`next --json` enrichment) — small, high-value polish on existing command.
6. #6 (`doctor --validate`) — independent, low-risk.
7. #2 (batch) with symbolic refs — the big one. Depends on #7.
8. #3 (`batch --dry-run`) — falls out of #2 nearly for free.
9. #8 (parent / epic) — only after we've resolved the containment-vs-sequencing
   question above.
10. #10 (promote to upstream) — own design doc, possibly own tool.
