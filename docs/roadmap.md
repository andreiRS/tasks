# Roadmap: non-goals and deferred decisions

What `tasks` deliberately does **not** do, and what was consciously postponed. This is the durable home for the boundary decisions that used to live in the PRD. Decisions that were *made* are recorded as ADRs in `docs/adr/`; the current command surface lives in `README.md`; the domain language lives in `CONTEXT.md`.

Forward-looking feature ideas aimed at agent ergonomics are tracked separately in `docs/agent-orchestration-ideas.md`.

## Out of scope (v1)

Explicitly excluded and not planned for the immediately following milestones:

- Multi-user collaboration, server-side sync, or any concept of remotes beyond `git push`/`pull` if a human chooses to use them.
- Subtasks. The model is flat: Tasks with Dependencies, nothing else (see ADR-0004).
- Configurable column sets per project. The six Columns are fixed in v1 (see ADR-0003, ADR-0010).
- A TUI. `tasks board` is a static print.
- Auto-dispatching Tasks to Claude Code sub-agents. `attendance` signals eligibility; the orchestration loop is a separate concern.
- An agent-driven `tasks breakdown` command that splits a Task into linked children.
- Enforced routing semantics for `attendance: unattended`. In v1 it is a plain enum with no automated dispatch (see ADR-0008).
- Cross-project dependencies. Each Project is isolated.
- Time tracking, due dates, priorities, recurring tasks, urgency scoring.
- Encryption at rest.

## Deferred (revisit before v2)

Considered during design and consciously deferred. Each has a v1 fallback and a trigger for revisiting.

- **npm distribution.** v1 ships GitHub releases with prebuilt macOS/Linux binaries (see ADR-0014, `RELEASING.md`). Revisit if users ask for `bunx tasks` or platform-coverage gaps emerge.
- **Auto-JSON output on non-TTY stdout** and a `TASKS_JSON` env var. v1 requires explicit `--json`. Revisit if agent ergonomics suffer.
- **Agent-vs-human attribution** (e.g. `TASKS_ACTOR`, `Co-Authored-By` trailers). v1 inherits the user's git identity for all commits. Revisit when there's a real need to audit agent activity distinctly.
- **Adaptive board layout** (auto-stack on narrow terminals). v1 is fixed-width side-by-side; pipe through `less -S`. Revisit if narrow-terminal use becomes common.
- **Rich markdown rendering in `show`.** v1 uses light ANSI styling only. Revisit if Task bodies grow large enough that prose readability matters.
- **`.tasks` marker file for explicit Project-root pinning.** v1 walks up to `.git` only (see ADR-0012). Revisit if users hit the no-`.git` fallback awkwardly.
- **Per-project config file** (custom `done` cutoff, custom column set). v1 uses fixed defaults and per-invocation flags. Revisit if projects need durably different settings.
- **Hard transition gating** (rejecting `mv ready` when deps incomplete). v1 leaves transitions open; the Validator only protects the DAG (see ADR-0005). Revisit if open transitions cause observable problems.
- **Whether `tasks next` should hint at blocked Tasks** instead of hard-filtering. v1 hard-filters. Revisit if agents would benefit from visibility into near-ready work.
- **Configurable `done` cutoff window.** v1 fixes the default at 7 days with `--all` and `--since <duration>` as overrides. Revisit alongside the per-project config-file question.
