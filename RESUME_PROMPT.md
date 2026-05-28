# Resume prompt for `tasks` v1 build (next session)

Paste the body below into a fresh Claude Code session at `/Users/razvan.surdu/Projects/tasks` to continue.

---

We are building the `tasks` CLI per `PRD.md` and `MILESTONES.md` in this directory. M1 through M7b are complete. **M8 is in progress: cycles 1-6 of 7 have landed; cycle 7 (renderer glyphs) is the next behavior.** There are also two queued followup fixes.

## Working method (NON-NEGOTIABLE)

- TDD, outside-in, at the CLI boundary. Every behavior is driven by a failing CLI E2E test first.
- One red-green cycle per agent spawn. You orchestrate; you do NOT code yourself. Subagents do the coding and commit.
- Atomic commits at every green. Commit message form: `green: <one-line behavior>` (HEREDOC, include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`).
- All work on `main`. No squashing, no rewriting history (no `--amend`). Lint/type fixups land as separate `fix:` or `refactor:` commits.
- Agents run BOTH `bun test` AND `bunx tsc --noEmit` before committing. Both must be clean. No unused imports.
- Tests live in `tests/`, spawn the binary via `Bun.spawn(["bun","run",cliPath,...])` against a `TASKS_HOME` tempdir; assert on stdout/stderr/exit code/on-disk state.
- When committing, stage specific files. Be deliberate; never sweep the worktree with `git add -A`.

## Agent model policy

- **Sonnet** for routine red-green cycles.
- **Opus** for complex/architectural cycles (renderer, validator, anything cross-cutting).

## Style notes

- Use `bun`, never `npm`.
- No em-dashes anywhere (chat, code, comments, commit messages, rendered output).

## Done in M8 so far

- **Cycle 1 (Opus, 9e79586)**: `attendance` (default `attended`) and `effort` (default `medium`) frontmatter fields. Validator rejects bad enums with `INVALID_ATTENDANCE` / `INVALID_EFFORT`. Read commands resolve missing values to defaults and always emit them in `--json`.
- **Cycle 2 (Sonnet, 540998d)**: `tasks new` flags: `--unattended`, `--effort`, `--deps`, `--edit`, `--body -`. `--edit` and `--body -` together error with `CONFLICT`.
- **Cycle 3 (Opus, 711c934)**: `tasks set <id|uuid> [--title|--attendance|--effort]`. Scalar setter, one commit per invocation. Title change recomputes slug + `git mv` (reuses `editTask` logic).
- **Cycle 4 (Sonnet, bd159ef)**: `tasks list --attendance` and `--effort` single-value filters. Compose AND with each other and with `--column`.
- **Cycle 5 (Sonnet, 42d69d1)**: `tasks next [--attendance|--unattended] [--json]`. Oldest `created_at` wins, ties broken by id ascending. `NO_READY_TASK` on empty. Read-only (no flock, no auto-init). Passing `--attendance attended` with `--unattended` errors with `CONFLICT`.
- **Cycle 6 (Opus, a20d369)**: Hand-rolled fence-aware case-insensitive Acceptance Criteria parser (`src/acceptance.ts`). Exposed as `acceptance_criteria` (string, `""` if absent) on `show`/`list`/`board`/`next` `--json`.

Plus docs: 6b62949 + 24136d6 landed CONTEXT.md and 8 ADRs from a sibling worktree (now removed). 2b0d7a4 updated PRD.md and MILESTONES.md to the attendance/effort terminology.

`bun test` → **208 pass, 1 fail** (the failure is pre-existing — see followups below). `bunx tsc --noEmit` → clean.

## What's queued next

### M8 cycle 7 (Sonnet): Renderer glyphs + show header

Per PRD line 181 and MILESTONES.md M8 last bullet:
- `tasks show` human rendering: header block now includes `attendance` and `effort` as full words.
- `tasks list` and `tasks board` human rendering: append compact dim-styled glyphs per row. PRD example glyphs: `○` (attended) / `●` (unattended), and `·L` / `·M` / `·H` for effort. Keep the kanban layout tight; the glyphs should NOT widen board columns.
- All glyphs respect the existing `--no-color` / `NO_COLOR` plumbing (the dim styling goes through the renderer module).
- Do NOT change `--json` output (already emits resolved attendance/effort since cycle 1).

### Followups (separate `fix:` commits, can be interleaved or batched)

1. **`tasks new --edit` produces two commits.** PRD says ONE commit per invocation. Cycle 2's agent noted this. Options: defer the initial creation commit until after the editor exits, or squash the two into one before persisting.
2. **`tests/cutoff.test.ts --since 1d` failing.** Pre-existing (fails even on commits before M8). Looks like a date-sensitivity / duration-parse bug. Worth a focused debugging cycle.

### After M8

- **M9**: `tasks undo`.
- **M10**: Ship (`bun build --compile`, README finalization).

## How to spawn the next cycle

Use the `Agent` tool with `subagent_type: "general-purpose"`. Default `model: "sonnet"`; switch to `opus` for the explicitly-complex cycles. Each prompt should:

1. Tell the agent to read `PRD.md` and `MILESTONES.md` first if context is needed.
2. State the ONE behavior to drive, with explicit test plan.
3. Call out what NOT to implement so the slice stays small.
4. Remind: failing test first → right-reason failure → minimal impl → `bunx tsc --noEmit` + `bun test` clean → one commit with HEREDOC message → terse report.
5. Warn about unused imports — the project's `tsc` flags them and they need a separate `fix:` commit if shipped.

After each agent returns, verify with `bun test`, `bunx tsc --noEmit`, and `git log --oneline | head -3`, then spawn the next.

## Six columns (canonical order)

`backlog ready doing blocked review done`

## External env

- bun 1.3.13+. `flock` at `/opt/homebrew/bin/flock` (required). macOS Darwin 25.4.0, zsh.

## Suggested first action on resume

Spawn cycle 7 (Sonnet): renderer glyphs and `show` header attendance/effort.
