# `tasks doctor` — Feature Spec

Status: proposed, not implemented. See ADR-0009.

## Motivation

The store's working tree must stay clean between mutating commands; every
`new`/`mv`/`rm`/`edit` hits a `STORE_DIRTY` guard otherwise. When the tree
*is* dirty (stray editor file, untracked draft, modified tracked file), the
user currently has to `cd` into a hidden, path-encoded store directory and
run raw `git` to recover.

`tasks doctor` is the supported way to inspect and remediate the store
from the project root, without ever needing to know where it lives or
learning git internals to clean it up.

## Command shape

```
tasks doctor             # report only — store path, status, stash count
tasks doctor --clean     # stash everything; tree becomes clean
tasks doctor --json      # machine-readable form of either mode
```

`doctor` never takes the flock, never validates schema, and never deletes
files. Recovery is non-destructive by construction.

## `tasks doctor` (report)

Prints, for the store directory of the current project:

- **Store path** — absolute, so the user finally sees it.
- **Status** — `git status --short` output of the store.
- **Stashes** — count of outstanding stashes (entries created by previous
  `doctor --clean` runs are visible here).

Always exits 0. This is diagnostic output, not a CI gate.

## `tasks doctor --clean`

Runs, inside the store directory:

```
git stash push --include-untracked --message "doctor <iso-ts>"
```

- On a dirty tree: prints the new stash ref (e.g. `stash@{0}`) and the
  store path, so the user can `cd <path> && git stash pop` if they want
  the contents back.
- On a clean tree: prints `store already clean`. No stash is created.
- Exit 0 in both cases.

## What's intentionally *not* here (v1)

- No `--force`, no interactive prompts, no `--include=<glob>`.
- No deletion of any kind. Strays, drafts, and accidentally-copied files
  are all preserved inside the stash; the user decides what to keep.
- No schema validation. Half-finished drafts with missing frontmatter
  fields are stashed alongside everything else, not flagged.
- No flock acquisition. `doctor` must be runnable when the store is in a
  weird state, including when other things hold the flock.
- No structured pruning of old stashes. `doctor` only surfaces the count;
  pruning is `git stash drop` for now.

These may return as separate commands (`doctor --check`, `doctor --repair`,
`doctor --stash <pop|list|drop>`) but are out of scope for the first cut.

## Test plan

- Strays present + `--clean` → tree clean afterward, exit 0, stash ref printed.
- Tracked-modified file present + `--clean` → stashed (not deleted), tree clean.
- Mix of modified + untracked + strays + `--clean` → all captured in one stash.
- Clean tree + `--clean` → `store already clean`, exit 0, no new stash.
- `doctor` (no flags) with strays present → exit 0, status lists them.
- `doctor` after N prior `--clean` runs → stash count = N.
- `doctor --json` → structured `{ store, status, stashes }` (and `stash_ref`
  on `--clean`).
