# `tasks doctor --clean` recovers via `git stash`, not file deletion

The store's dirty-tree guard means any stray file (editor droppings, half-finished drafts, accidental `cp` into the store) blocks every subsequent mutating command, and recovery previously required `cd`-ing into a hidden path-encoded directory and running raw `git`. `tasks doctor --clean` instead runs `git stash push --include-untracked` inside the store: the working tree is guaranteed clean afterward, nothing is deleted, and recovery uses stock `git stash pop`. Chosen over a pattern-based "delete known junk" cleaner because that design either duplicates the existing gitignore (solving nothing) or grows toward `git clean -fdx` semantics that can silently destroy user data; the stash is fully reversible and uniformly handles every flavor of dirty state (modified tracked files, untracked files, strays, drafts) with a single git primitive.

## Consequences

- `tasks doctor` is purely diagnostic: it never takes the store flock, never validates schema, and always exits 0. Schema/repair concerns are deferred to a future `doctor --check` / `doctor --repair`.
- Stashes can accumulate silently across repeated `--clean` runs. `tasks doctor` (report mode) lists the outstanding stash count to surface this; pruning is left to raw `git stash drop` in v1.
- The user still touches raw git to recover stashed contents. Acceptable in v1; a `doctor --stash <pop|list|drop>` wrapper can be added later if it bites.
