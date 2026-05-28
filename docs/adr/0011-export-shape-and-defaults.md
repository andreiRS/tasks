# Export and Summary shape and defaults

`tasks export --json` is a dedicated Read command (not a flag on `list`) that emits the whole live Store in one call for agent consumption. Bodies are included by default for live Columns; the Archive is excluded by default but any Archived Task referenced as a Dep by a live Task is included as an Archive Stub (`{ id, uuid, title, column, complete }`, no Body) so the Dep graph is never dangling. Tasks are grouped by Column in fixed order then sorted by `created_at` ascending, giving deterministic diffs across invocations.

`tasks summary --json` is a separate command, not a flag on `export`: it returns `counts` (per Column), `recent` (last 10 by `updated_at`, override with `--recent N`), and `stale` (live-Column Tasks in `doing`/`blocked`/`review` untouched for 14+ days, override with `--stale <duration>`), with no `tasks` array. Keeping it a separate verb means one command = one response shape, matching the existing convention (`list`, `show`, `board`, `next` all have distinct shapes) and giving `tasks schema <command>` a clean 1:1 mapping.

## Considered Options

- Extending `list --json` with flags. Rejected: `list` already carries Cutoff, column filters, and `--blocked`; layering "whole-store dump including HEAD SHA, schema version, dep graph" on top conflates a human-facing kanban view with an agent-facing data contract.
- One `export` command with a `--summary` flag that swaps the response envelope. Rejected: a flag that changes the entire response shape is a known footgun for JSON consumers, forces schema unions, and breaks the project's "one verb, one shape" convention.
- Bodies opt-in via `--include-body`. Rejected: the common agent case is "give me the store with enough context to work," and forcing the flag on every call adds friction without benefit; the live/archive split already bounds payload size.
- Including the full Archive by default. Rejected: Archive grows unbounded over Project life and is almost never load-bearing for an agent picking up live work; the Archive Stub design preserves the only Archive property that matters for live state (Completeness for blocking).

## Consequences

- The output shape is a stable contract once agents depend on it; additive changes only, per the existing JSON mode rule.
- Two distinct envelopes (full vs. summary) means consumers branch on mode; this is intentional to keep each payload tightly scoped.
- The Archive Stub is a new partial-Task shape in the wire format; documented in `CONTEXT.md` so it does not get reinvented elsewhere.
