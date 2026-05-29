# Store directory name is a reversible encoding of the Project root path

A Project's absolute root path is turned into its Store directory name by doubling every literal `-` to `--`, then replacing every `/` with `-`. So `/Users/andrei/Projects/tasks` becomes `-Users-andrei-Projects-tasks` and `/Users/a-b/c` becomes `-Users-a--b-c`. Chosen over a plain `/`→`-` substitution (which collides: `/Users/a-b/c` and `/Users/a/b/c` would both encode to `-Users-a-b-c`) and over a hash (which is not reversible and makes the on-disk layout unreadable). The scheme mirrors Claude Code's per-project state convention under `~/.claude/projects/` so the two layouts feel the same.

## Consequences

- The encoding is the *contract* for Store location, not an imported dependency. If Claude Code changes its internal encoding, this tool stays compatible by spec, not by code coupling.
- Project root is resolved per invocation by walking up from `pwd` to the nearest `.git/`, falling back to literal `pwd` when none is found. A `.tasks` marker file for explicit pinning is deferred (see `docs/roadmap.md`).
