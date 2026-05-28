# The CLI is the only sanctioned writer

All mutations to the Store go through the `tasks` CLI, which acquires the Lock, runs the Validator, writes files, and commits as one atomic step. Direct edits to files in the Store are unsupported and may be rejected by the Dirty-tree guard on the next CLI call. This is the contract that lets humans and agents share the same Store safely; without it the Validator would be bypassable and the DAG could be corrupted.

## Consequences

- Agents must shell out to `tasks` rather than reading and writing Task files directly.
- A future "library" API would need to enforce the same invariants, so it has not been built; the CLI is the API.
