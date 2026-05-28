# `tasks doctor --clean` — Feature Spec

Status: proposed, not implemented.

## Motivation

The store's working tree must stay clean between mutating commands; every
`new`/`mv`/`rm`/`edit-followup` hits a `STORE_DIRTY` guard otherwise. Editor
droppings (`.swp`, `*~`, `.DS_Store`, `.#*`) are handled by a `.gitignore`
seeded at store init, but two classes of mess slip past:

1. Files an editor created that the user wants to keep but doesn't want
   tracked (notes, scratch YAML, half-finished task drafts).
2. Files the gitignore doesn't cover (unusual editor names, new OS junk,
   accidental `cp`/`mv` into the store).

The user then has to `cd` into a hidden, path-encoded store directory and
run raw `git` to recover. `tasks doctor --clean` is the supported way to
inspect and remediate the store from the project root.

## Command shape

```
tasks doctor                    # report only — never modifies
tasks doctor --clean            # interactive: list strays, prompt y/N per file
tasks doctor --clean --force    # non-interactive: delete all reported strays
tasks doctor --clean --json     # machine-readable report + actions taken
```

All forms require the flock (same as other mutating commands) so a
concurrent `tasks new` can't race the cleanup.

## What `doctor` reports

For the store directory of the current project:

- **Store path** — absolute path, so the user finally sees it.
- **Git status** — `git status --short` output, grouped by:
  - `staged`     — files in the index awaiting commit
  - `modified`   — tracked files with unstaged changes
  - `untracked`  — files git would track that aren't tracked yet
  - `stray`      — untracked files matching known disposable patterns
                   (`.swp`, `~`, `.DS_Store`, `.#*`, `*.bak`, `*.orig`)
- **Schema sanity** — meta.yaml present, all six column dirs present,
  every `.md` file parses and has required frontmatter fields.
- **Lock state** — whether `.tasks-lock` is held by a live PID.

Exit code: 0 if everything is clean, 1 if any issue is reported (so it
can be wired into CI / pre-commit hooks).

## What `--clean` does

Only operates on the `stray` bucket. Never touches:

- Tracked files (use git directly if you want to discard).
- Untracked files outside the stray pattern set (use `git clean` if you
  truly mean it; doctor will not silently delete user data).
- The flock file.
- `.git/` contents.

Interactive default lists each stray with size + mtime and prompts
`delete? [y/N]`. `--force` deletes without prompting. `--json` emits
`{ removed: [...], kept: [...], errors: [...] }`.

## Out of scope

- Reformatting task files.
- Repairing broken graph state (cycles, missing UUIDs) — that's a separate
  `tasks doctor --repair` later.
- Auto-running on every command (rejected: would mask real user data loss).

## Test plan

- Strays present + `--force` → all removed, exit 0, store clean afterward.
- Tracked-but-modified file present → reported as `modified`, never deleted.
- Random `notes.txt` in store → reported as `untracked`, never deleted.
- `doctor` (no flags) with a clean tree → exit 0, no changes.
- `doctor --clean` while another process holds the flock → `FLOCK_BUSY`.
