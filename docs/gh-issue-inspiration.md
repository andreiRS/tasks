# gh issue as inspiration

`gh issue` (GitHub CLI, the `issue` noun) is a mature, widely-used CLI for managing
work items. We treat its **command grammar** as a reference model for our own CLI and
migrate toward it where it fits. This doc records the full `gh issue` surface verbatim
plus a gap analysis against `tasks`. It is a living document: update the scorecard as we
migrate, and record adopt/reject verdicts here once we make them.

No verdicts yet. The "tasks today" and "alignment" columns describe where we stand; the
"verdict" column is intentionally left `TBD` until we decide per item.

Two layers to keep separate when reading this:

- **CLI grammar** — verb-noun shape, flag conventions, composable machine output,
  list ergonomics (`--search`, `--limit`, selective `--json`). Portable, provider-neutral.
  This is the layer worth migrating toward.
- **GitHub domain** — assignees, labels, milestones, projects, lock/pin/transfer,
  open/closed binary state, `--web`. This is a *different* model, not a better one. We
  deliberately chose columns + a dependency DAG + attendance instead. Recorded here for
  completeness; adopting any of it is a model change, not a grammar fix.

`gh` version captured: run `gh --version` to confirm; this snapshot taken 2026-06-09.

---

## 1. Full `gh issue` surface (verbatim)

### Top-level

```
gh issue <command> [flags]

GENERAL COMMANDS
  create   Create a new issue          (alias: new)
  list     List issues in a repository (alias: ls)
  status   Show status of relevant issues

TARGETED COMMANDS
  close, comment, delete, develop, edit, lock, pin, reopen,
  transfer, unlock, unpin, view

INHERITED / GLOBAL
  -R, --repo [HOST/]OWNER/REPO
      --help
```

An issue is supplied as a positional argument by number (`123`) or URL.

### `create` (alias `new`)

| Flag | Short | Type | Note |
|------|-------|------|------|
| `--assignee` | `-a` | login (repeatable) | `@me`, `@copilot` special values |
| `--body` | `-b` | string | prompts if omitted |
| `--body-file` | `-F` | file | `-` reads stdin |
| `--editor` | `-e` | bool | first line = title, rest = body |
| `--label` | `-l` | name (repeatable) | |
| `--milestone` | `-m` | name | |
| `--project` | `-p` | title | needs `project` scope |
| `--recover` | | string | recover input from a failed run |
| `--template` | `-T` | name | starting body text |
| `--title` | `-t` | string | prompts if omitted |
| `--web` | `-w` | bool | open browser to create |

### `list` (alias `ls`)

| Flag | Short | Type | Note |
|------|-------|------|------|
| `--app` | | string | filter by GitHub App author |
| `--assignee` | `-a` | string | |
| `--author` | `-A` | string | |
| `--label` | `-l` | strings | |
| `--limit` | `-L` | int | default 30 |
| `--mention` | | string | |
| `--milestone` | `-m` | string | number or title |
| `--search` | `-S` | query | GitHub search syntax |
| `--state` | `-s` | string | `open` (default) / `closed` / `all` |
| `--json` | | fields | output JSON with named fields |
| `--jq` | `-q` | expression | filter JSON via jq |
| `--template` | `-t` | string | Go-template the JSON |
| `--web` | `-w` | bool | |

JSON fields: `assignees, author, body, closed, closedAt,
closedByPullRequestsReferences, comments, createdAt, id, isPinned, labels,
milestone, number, projectCards, projectItems, reactionGroups, state,
stateReason, title, updatedAt, url`.

### `view`

| Flag | Short | Note |
|------|-------|------|
| `--comments` | `-c` | view comments |
| `--json` / `--jq` / `--template` | | `-q`, `-t` | same formatting trio as `list` |
| `--web` | `-w` | open in browser |

### `edit` (accepts multiple issue numbers/urls)

| Flag | Short | Note |
|------|-------|------|
| `--title` | `-t` | set new title |
| `--body` | `-b` | set new body |
| `--body-file` | `-F` | `-` reads stdin |
| `--add-label` / `--remove-label` | | by name |
| `--add-assignee` / `--remove-assignee` | | `@me`, `@copilot` |
| `--add-project` / `--remove-project` | | by title |
| `--milestone` | `-m` | set milestone |
| `--remove-milestone` | | clear milestone |

### `status`

Relevant-to-me digest (assigned, mentioned, opened). Formatting trio
`--json` / `--jq` / `--template` only.

### `close`

| Flag | Short | Note |
|------|-------|------|
| `--comment` | `-c` | closing comment |
| `--reason` | `-r` | `completed` / `not planned` / `duplicate` |
| `--duplicate-of` | | mark duplicate of another issue |

### `reopen`

| Flag | Short | Note |
|------|-------|------|
| `--comment` | `-c` | reopening comment |

### `delete`

| Flag | Note |
|------|------|
| `--yes` | confirm without prompting |

### `comment`

| Flag | Short | Note |
|------|-------|------|
| `--body` | `-b` | comment text |
| `--body-file` | `-F` | `-` reads stdin |
| `--editor` | `-e` | open editor |
| `--web` | `-w` | open browser |
| `--edit-last` / `--delete-last` | | operate on caller's last comment |
| `--create-if-none` | | with `--edit-last`, create if none |
| `--yes` | | skip delete confirmation |

### Other targeted commands (domain-only, no flag detail captured)

`develop` (linked branches), `lock` / `unlock` (conversation), `pin` / `unpin`,
`transfer` (to another repo).

### Cross-cutting patterns worth naming

- **Verb-noun**: every action is `gh issue <verb>`.
- **Aliases**: `new`→`create`, `ls`→`list`.
- **Positional target**: number or URL, no `--id` flag.
- **Formatting trio**: `--json <fields>` + `-q/--jq <expr>` + `-t/--template <tpl>`
  appears on every read command, consistently.
- **Symmetric add/remove**: `--add-label`/`--remove-label` on `edit`.
- **Short + long flag pairs** on nearly every flag.
- **Special tokens**: `@me`, `@copilot` for assignee.

---

## 2. Gap scorecard: tasks vs the gh grammar

Verdict is `TBD` for all rows until we decide. `by-design` in the notes marks places
our model intentionally diverges.

| gh grammar trait | tasks today | Alignment | Verdict |
|------------------|-------------|-----------|---------|
| Verb-noun command shape | flat `tasks <verb>` (same shape) | Strong | TBD |
| One atomic op per command | every mutation = 1 git commit (stricter) | Strong | TBD |
| Stable machine output | `--json` envelope + stable error codes | Strong | TBD |
| Positional target (no `--id`) | `tasks <verb> <id\|uuid>` positional | Strong | TBD |
| Short + long flag pairs | long-only everywhere | Weak | TBD |
| Command aliases (`new`, `ls`) | none | Weak | TBD |
| Selective JSON (`--json f1,f2`) | all-or-nothing `--json` | Missing | TBD |
| jq filter (`-q/--jq`) | none (pipe to external jq) | Missing | TBD |
| Go-template output (`-t`) | none | Missing | TBD |
| `--search` query on lists | none | Missing | TBD |
| `--limit` on lists | none (age-window via `--since`/`--all`) | Partial / by-design | TBD |
| Multiple body inputs | `--body <text>` + `--body-file <path>` (`-` = stdin) + `--edit` | Strong | Adopted (#2) |
| Symmetric add/remove flags | `link`/`unlink` as separate verbs | by-design | TBD |

### GitHub-domain features (model change, not grammar)

| gh feature | tasks analog | Notes |
|------------|--------------|-------|
| open/closed `--state` | six columns (`backlog…done`) + `mv` | by-design: state = directory |
| `close` / `reopen` | `mv <id> done` / `mv <id> <col>` | no dedicated verbs |
| labels (`-l`, add/remove) | `--effort` (enum), `--attendance` (enum) | no free-form tags |
| assignees (`-a`, `@me`) | `attendance: attended\|unattended` | no person model |
| milestones (`-m`) | none | |
| projects (`-p`) | the store *is* the project | |
| comments | task markdown body + `git log` | no comment stream |
| `develop` (branches) | none | out of scope |
| `lock`/`pin`/`transfer` | none | GitHub-social, no analog |
| `--web` | none | local files, no web |
| `--recover` | `tasks edit --abort`, `tasks doctor` | git-based recovery instead |

### Where tasks is richer than gh

No gh analog exists for these; they fall out of our git-backed, dependency-aware model:

- Dependency DAG: `link` / `unlink` / `next`, with `CYCLE_DETECTED` / `UNKNOWN_UUID`
  validation.
- Column transitions and the `board` kanban view.
- `attendance` as an agent-pickup gate; `next --unattended`.
- Store ops: `undo` (git revert), `archive`, `doctor`, `export`, `init`.

---

## 3. Migration log

Record each adopt/reject decision here as we make it, with a date and a pointer to the
ADR or commit that landed it. Empty until the first decision.

| Date | Trait | Decision | Landed in |
|------|-------|----------|-----------|
| — | — | — | — |
