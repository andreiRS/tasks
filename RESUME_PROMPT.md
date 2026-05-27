# Resume prompt for `tasks` v1 build

Paste the body below into a fresh Claude Code session at `/Users/razvan.surdu/Projects/tasks` to continue.

---

We are building the `tasks` CLI per `PRD.md` and `MILESTONES.md` in this directory. The repo is initialized; we are partway through M1.

## Working method (NON-NEGOTIABLE)

- TDD, outside-in, at the CLI boundary. Every behavior is driven by a failing CLI E2E test first.
- One red-green cycle per agent spawn. You orchestrate; you do NOT code yourself. Subagents do the coding and commit.
- Atomic commits at every green. Commit message form: `green: <one-line behavior>` (use HEREDOC, include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`).
- All work on `main`. No squashing, no rewriting history (no `--amend`). Lint/type fixups land as separate `fix:` or `refactor:` commits.
- Agents must run BOTH `bun test` AND `bunx tsc --noEmit` before committing. No unused vars, no type errors.
- Tests live in `tests/`, spawn the binary via `Bun.spawn(["bun","run",cliPath,...])` against a `TASKS_HOME` tempdir; assert on stdout/stderr/exit code/on-disk state. No git mocking. No assertions on internal modules.

## Agent model policy

- **Sonnet** by default for routine red-green cycles.
- **Opus** for complex/tricky cycles (concurrency, dirty-tree race conditions, renderer architecture, anything cross-cutting).

## Style notes given by the user

- Use `bun`, never `npm`.
- Never use em-dashes in written conversation with the user.

## Current state (commits, newest first)

```
fe30ed0 refactor: drop unused findFlock helper
1b0afad green: mutating commands fail with FLOCK_MISSING when flock is absent
e948d75 green: tasks new takes exclusive flock for the mutation
645134e fix: drop unused imports/destructures in show.test.ts
8086765 green: tasks show --json returns structured task and NOT_FOUND envelope
f4cf7e8 green: tasks new enforces single-line title and 200-char max
4a2ca9b green: tasks new writes task file and commits it
8a227d1 green: tasks new auto-initializes the store on first invocation
717c6b7 green: tasks new with no title exits non-zero with INVALID_TITLE
5ef2ac7 chore: scaffold Bun + TypeScript project
a2e4d47 docs: PRD and milestones for tasks v1
```

`bun test` → **16 pass**, 4 files. `bunx tsc --noEmit` → clean.

## What's done in M1

- Path resolver (cwd walk-up to `.git`, fallback to cwd, encode with `--` doubling). Walk-up to `.git` is NOT yet directly tested.
- Auto-init store (git init, empty commit, six column dirs, stderr notice, `.gitignore` for `.tasks-lock`).
- `tasks new "<title>"` writes task file + meta.yaml + commit atomically.
- Title constraints: non-empty, single-line, ≤200 chars (with 200-char boundary pinned).
- `tasks show <id|uuid> --json` returns normalized structured task; `--json` NOT_FOUND envelope; plain-text error without `--json`; read commands do NOT auto-init.
- `flock` wraps every mutation (concurrent `tasks new` produces distinct ids).
- `FLOCK_MISSING` error code: clear actionable error when flock is absent from PATH.

## What's still pending in M1 (next cycles)

1. **Dirty-tree guard + `STORE_DIRTY`** — every mutating command, after acquiring the lock, refuses if the store working tree is dirty. Test: pre-dirty the tree via raw `git` (`echo x > <store>/dirty.txt && git -C <store> add dirty.txt`), then run `tasks new "x"` and assert non-zero, `STORE_DIRTY` in stderr (and envelope when `--json`), no new commit. Per PRD, `tasks edit` is the exception (allowed when dirty); we don't have edit yet, so just enforce the guard.
2. **Path resolver: walk-up to `.git`** — currently only the fallback (no `.git` ancestor) is tested. Add a test that creates `.git/` in cwdDir (`mkdir <cwd>/.git`) and a deeper subdir; run from the subdir and assert the store encodes the `.git`-rooted path, not the subdir's.
3. **Path encoding: `--` doubling edge case** — test that `/Users/a-b/c` and `/Users/a/b/c` (both with a `.git` at root) produce distinct store paths.

After those three cycles, M1 should be complete.

## What's queued after M1 (per MILESTONES.md)

- **M2**: Human renderer for `tasks show` + `--no-color` / `NO_COLOR` plumbing through a shared renderer module. Opus is probably warranted because every later command's rendering goes through this module.
- **M3, M4**: list / board / filters / cutoff.
- **M5**: mv.
- **M6**: edit + rm (basic).
- **M7a**: DAG + rm cascade.
- **M7b**: link / unlink / show blockers.
- **M8**: agent collaboration (`tasks next`, `--edit`, `--body -`, `--deps`, acceptance criteria parser).
- **M9**: undo.
- **M10**: ship (build + README).

## How to spawn the next cycle

Use the `Agent` tool with `subagent_type: "general-purpose"`. Default `model: "sonnet"`; switch to opus only for the explicitly-complex cycles called out above. Each prompt should:

1. Tell the agent to read `PRD.md` and `MILESTONES.md` first, then list the current commits and current source files.
2. State the ONE behavior to drive, with explicit test plan (file path, test names, what to assert).
3. Call out what NOT to implement so the slice stays small.
4. Remind: failing test first → confirm right-reason failure → minimal impl → `bun test` + `bunx tsc --noEmit` clean → one commit with HEREDOC message → report back.
5. End with "Stop after ONE cycle."

After each agent returns, run `bun test`, `bunx tsc --noEmit`, and `git log --oneline | head -3` to verify, then spawn the next.

## External env

- bun 1.3.13 installed (PRD wants 1.3.14+; `bun upgrade` is fine to run, not blocking).
- `flock` at `/opt/homebrew/bin/flock`. Required.
- macOS Darwin 25.4.0, zsh.

## Suggested first action on resume

Spawn the dirty-tree guard cycle (Sonnet). After that, the two path-resolver cycles (Sonnet). Then mark M1 done and move to M2 (Opus for the renderer architecture).
