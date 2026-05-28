# Git-backed markdown store, one repo per project

State is kept as one markdown file per Task in a per-project git repository under `$TASKS_HOME/projects/<encoded-path>/`. Every mutating CLI command produces exactly one git commit, so the audit log is `git log` and recovery is `git revert`. Chosen over a single SQLite database or a cloud backend because it gives humans grep/diff/backup of plain files, gives agents stable diffs to review, and removes the operational burden of a service for a single-user CLI.

## Consequences

- The CLI is responsible for atomicity (Lock + Validator + commit form one critical section). The file system on its own provides none.
- Cross-project queries are not possible without iterating Stores; this is deliberate, each Project is isolated.
