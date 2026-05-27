# Resume prompt for `tasks` v1 build (next session)

Paste the body below into a fresh Claude Code session at `/Users/razvan.surdu/Projects/tasks` to continue.

---

We are building the `tasks` CLI per `PRD.md` and `MILESTONES.md` in this directory. M1 through M7a are complete; we are starting M7b.

## Working method (NON-NEGOTIABLE)

- TDD, outside-in, at the CLI boundary. Every behavior is driven by a failing CLI E2E test first.
- One red-green cycle per agent spawn. You orchestrate; you do NOT code yourself. Subagents do the coding and commit.
- Atomic commits at every green. Commit message form: `green: <one-line behavior>` (HEREDOC, include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`).
- All work on `main`. No squashing, no rewriting history (no `--amend`). Lint/type fixups land as separate `fix:` or `refactor:` commits.
- Agents run BOTH `bun test` AND `bunx tsc --noEmit` before committing. They can also use the `LSP` deferred tool (load via `ToolSearch select:LSP`) for fast incremental type checks during edits.
- Tests live in `tests/`, spawn the binary via `Bun.spawn(["bun","run",cliPath,...])` against a `TASKS_HOME` tempdir; assert on stdout/stderr/exit code/on-disk state.
- When committing, stage specific files (or carefully scope `git add -A`). Stray working-tree deletes have been swept in once before — be deliberate.

## Agent model policy

- **Sonnet** for routine red-green cycles.
- **Opus** for complex/architectural cycles (renderer, validator, anything cross-cutting like the `edit` round-trip).

## Style notes

- Use `bun`, never `npm`.
- No em-dashes anywhere (chat, code, comments, commit messages, rendered output).

## Current state (newest first)

```
56165a9 fix: drop unused parseYaml import in rm-cascade.test.ts
ea5918c green: tasks rm refuses on dependents and --force cascades the strip
9fdeee6 green: validator enforces DAG rules (UNKNOWN_UUID + CYCLE_DETECTED) on mutations
d2df609 green: tasks edit round-trips through EDITOR with validation and abort
bf305c4 fix: drop unused readFileSync import in rm.test.ts
... (see `git log --oneline | head -30` for the full ledger)
```

`bun test` → **110 pass**, 14 files. `bunx tsc --noEmit` → clean.

## Done so far

- **M1**: Capture and inspect (JSON). `tasks new`, `tasks show`, flock, dirty-tree guard, store path resolver (walk-up to `.git`, hyphen-doubling encoding).
- **M2**: Human renderer + color. `tasks show` human output. ANSI styling via `style()` helper. Precedence: `--no-color` > `NO_COLOR` > `FORCE_COLOR=1` > TTY-default.
- **M3**: Flat list. `tasks list` (human + `--json`).
- **M4**: Filters, board, cutoff. `tasks list --column` (OR-combine, repeatable). `tasks board` (stacked sections; `--json` returns `{ <column>: TaskData[] }` for all six). Default cutoff hides `done` tasks older than 7d; `--all` and `--since <Nd>` override.
- **M5**: Move. `tasks mv <id|uuid> <column>`. Same-column no-op. Bumps `updated_at`. `INVALID_COLUMN` enum entry.
- **M6**: Edit and delete. `tasks edit` round-trips through `$EDITOR`, validates on save, title-change does atomic content-update + `git mv` in one commit. `tasks edit --abort` resets working tree. Exempt from `STORE_DIRTY`. `tasks rm <id|uuid>` deletes + commits.
- **M7a**: DAG model and rm cascade. `deps: []` in frontmatter. `validateGraph()` enforces `UNKNOWN_UUID` and `CYCLE_DETECTED` on every mutation that could produce new edges. `tasks rm` refuses with `DEP_EXISTS` if dependents exist; `tasks rm --force` cascades the strip in one atomic commit, prints `affected: #<id> <title>` lines to stderr.

## Six columns (canonical order)

`backlog ready doing blocked review done`

## What's queued next

- **M7b**: `tasks link <id|uuid> --depends-on <id|uuid>...` and `tasks unlink ...` (repeatable, single commit per invocation). Extend `tasks show` human + `--json` to render forward deps as `#id title` and reverse edges (what this task blocks). Reuse `validateGraph()` — link/unlink should inherit cycle + unknown-uuid checks automatically. Suggested slicing: (1) `link` command; (2) `unlink` command; (3) `show` extension for forward+reverse edges.
- **M8**: Agent collaboration. `tasks next`, `--edit`, `--body -`, `--deps`, acceptance criteria parser.
- **M9**: Undo.
- **M10**: Ship (build + README).

## How to spawn the next cycle

Use the `Agent` tool with `subagent_type: "general-purpose"`. Default `model: "sonnet"`; switch to `opus` for the explicitly-complex cycles. Each prompt should:

1. Tell the agent to read `PRD.md` and `MILESTONES.md` first, then list current commits and current source files.
2. State the ONE behavior to drive, with explicit test plan.
3. Call out what NOT to implement so the slice stays small.
4. Remind: failing test first → right-reason failure → minimal impl → `LSP` incremental + `bunx tsc --noEmit` + `bun test` clean → one commit with HEREDOC message → terse report (<150 words).
5. End with "Stop after ONE cycle."

After each agent returns, verify with `bun test`, `bunx tsc --noEmit`, and `git log --oneline | head -3`, then spawn the next.

## Known editor-diagnostic quirk

After each new test file is created, the editor often emits stale diagnostics like `Cannot find module '../src/render.ts'`. Ignore these if `bunx tsc --noEmit` is clean. They clear on the next save.

## External env

- bun 1.3.13 (PRD wants 1.3.14+; non-blocking).
- `flock` at `/opt/homebrew/bin/flock`. Required.
- macOS Darwin 25.4.0, zsh.

## Suggested first action on resume

Spawn the M7b `link` cycle (Sonnet). Then `unlink` (Sonnet). Then the `show` extension (Opus for the renderer touch).
