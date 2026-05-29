---

kanban-plugin: board

---

## Backlog

- [ ] **2 · Build the output module + unified failure path**
	**Attendance:** unattended  ·  **Blocked by:** slice 1
	**What to build:** Implement the output module to the agreed interface and route every command's failure through it. Replace the per-command error branching (`writeJsonError` / `writePlainError` / `handleTasksError`) so a `TasksError` becomes the Error envelope on stderr with the right non-zero exit in JSON mode, and a plain `CODE: message` line otherwise. One place now owns failure output and exit codes; `cli/errors.ts` folds inward. Commands still produce their success output the old way for now — only the failure path moves.
	**Acceptance:**
	- [ ] Output module emits the Error envelope and plain error identically to today
	- [ ] All commands route failures through the module
	- [ ] Exit codes unchanged across every error path
	- [ ] `cli/errors.ts` has no remaining callers for the failure path
	- [ ] `bun test` green

- [ ] **3 · Migrate Read commands to return a Result**
	**Attendance:** unattended  ·  **Blocked by:** slice 2
	**What to build:** Convert the Read commands — show, list, next, board, doctor, export, summary — so each returns a success Result instead of choosing JSON-vs-text in place. The output module renders the JSON payload or the text form via the Renderer. The JSON mode output (including `acceptance_criteria`, blockedBy, Export/Summary envelopes) and the human text are byte-for-byte what they are today.
	**Acceptance:**
	- [ ] All seven Read commands return a Result; no `if (jsonFlag)` branch left in them
	- [ ] `--json` output unchanged for every Read command (envelope + fields)
	- [ ] Text output unchanged (colour, cutoff, blocked-by markers)
	- [ ] `bun test` green

- [ ] **4 · Migrate Mutating commands to return a Result**
	**Attendance:** unattended  ·  **Blocked by:** slice 2
	**What to build:** Convert the Mutating commands — new, mv, rm, set, link, unlink, edit, archive, undo, init — to return a success Result. The before/after change set (the `changed` diff in `set`, affected counts in `rm`/`archive`, allocated Short ID in `new`, reverted SHAs in `undo`) is carried in the Result and turned into the success envelope by the output module. The success envelope shape per command is unchanged.
	**Acceptance:**
	- [ ] All ten Mutating commands return a Result; no `if (jsonFlag)` success branch left in them
	- [ ] `--json` success envelopes unchanged per command (incl. `changed` diffs, counts, ids, SHAs)
	- [ ] Text / silent success behaviour unchanged
	- [ ] `tasks edit` still skips the dirty-tree guard (no regression)
	- [ ] `bun test` green

- [ ] **5 · Remove dead shallow helpers**
	**Attendance:** unattended  ·  **Blocked by:** slices 3, 4
	**What to build:** With every command going through the output module, delete the helpers left with zero callers (e.g. `cli/errors.ts`) and inline or drop any remaining glue that no longer earns its place. The colour decision lives in the output module now. Pure cleanup — no observable behaviour change.
	**Acceptance:**
	- [ ] Helpers with zero callers deleted
	- [ ] No command rebuilds the JSON-vs-text branch or the error envelope by hand
	- [ ] No dead exports remain in `src/cli/`
	- [ ] `bun test` green


## Doing



## Done

- [x] **1 · Decide the Result + output-module interface**
	**Attendance:** attended (design review)  ·  **Blocked by:** none
	**Decided:** Strict byte-for-byte preserve (error envelope stays `{error:{…}}` with no top-level `ok:false`; `new --json` keeps emitting plain text only — both warts preserved, normalising them is a separate follow-up). Output module is a side-effecting sink: `emit(result, ctx): never` writes the envelope/text + picks the exit code + exits. Colour decision (`shouldColor`) lives in the module via `outputContext(rest)`; `text(ctx)` receives it. `plainFormat: "prefixed" | "raw"` on the failure variant preserves today's two stderr shapes (raw = already-prefixed flock messages).
	**Delivered:** `src/cli/output.ts` — `OutputContext`, `CommandResult`, `outputContext()`, `emit()`. No command migrated yet; `bun test` green (331 pass).

%% kanban:settings
```
{"kanban-plugin":"board","show-checkboxes":true,"new-card-insertion-method":"append"}
```
%%
