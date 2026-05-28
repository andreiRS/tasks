# Open Column transitions; the Validator only protects the DAG

`tasks mv` accepts any Task into any Column regardless of whether its forward Deps are Complete. The Validator still rejects writes that corrupt the DAG (cycles, unknown UUIDs), but it does not gate Column moves on dependency state. Chosen because strict gating would force every agent move through a graph traversal for marginal benefit, while leaving transitions open keeps the CLI predictable and uses `git log` as the reviewable record of who moved what when.

## Consequences

- An agent can move a dep-blocked Task into `doing`; this is an accepted risk, the graph itself stays intact.
- `tasks next` is the single place where "all deps Complete" is enforced, so the rule lives at the read side, not the write side.
