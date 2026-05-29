# Mutating commands serialize on an exclusive `flock(1)`

Every mutating command takes an exclusive lock on `<store>/.tasks-lock` by shelling out to the system `flock(1)` via `Bun.spawn`, held for the command's full duration. The lock makes Short ID allocation (`max(id)+1` from `meta.yaml`), validation, file writes, and the git commit a single critical section, so two simultaneous `tasks new` invocations serialize cleanly instead of colliding on the same id or interleaving partial state. The dirty-tree guard runs **after** the lock is acquired so concurrent invocations queue rather than racing the check. Read commands never take the lock. Chosen over an in-process mutex (which cannot coordinate across separate CLI processes — the actual concurrency model when a human and an agent run at once) and over a hand-rolled lockfile dance (prone to stale-lock and races that `flock` already solves correctly).

## Consequences

- `flock` is a required external binary. On Linux it ships with util-linux; on macOS it is **not** bundled and must be installed (`brew install flock`). When `flock` is missing from `$PATH`, mutating commands fail fast with `FLOCK_MISSING` and an actionable install hint; the README calls this out under Requirements.
- The lock is per-Store, so unrelated projects never contend.
