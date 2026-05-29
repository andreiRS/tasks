---

kanban-plugin: board

---

## Backlog



## Doing



## Done

- [x] **5 · Remove dead shallow helpers**
	**Attendance:** unattended  ·  **Blocked by:** slices 3, 4
	**Delivered:** Deleted `src/cli/errors.ts` (zero callers). De-exported `ensureCleanStore` (only `mutatingPreamble` uses it) so no dead export remains in `src/cli/`. Verified no command rebuilds the JSON-vs-text branch or the error envelope by hand — the only surviving `ctx.json` refs are export/summary's `--json`-required failure guard and init's stderr "already exists" side-channel. Colour lives in the output module (`shouldColor` has one caller: `outputContext`). `bun test` green (331 pass).

- [x] **4 · Migrate Mutating commands to return a Result**
	**Attendance:** unattended  ·  **Blocked by:** slice 2
	**Delivered:** new, mv, rm, set, link, unlink, edit, undo, archive, init now hand a `CommandResult` to `emit()`; no `if (json)` success branch remains. Silent-in-text mutations emit json-only; undo/archive carry json + text; init keeps its stderr notice as a side-channel; `new`'s always-plain line preserved via a forced-text context. `edit` still skips the dirty-tree guard. Done in a parallel worktree agent. `bun test` green (331 pass).

- [x] **3 · Migrate Read commands to return a Result**
	**Attendance:** unattended  ·  **Blocked by:** slice 2
	**Delivered:** show, list, next, board, doctor, export, summary now hand a `CommandResult` to `emit()`; `shouldColor`/`noColorFlag` removed from commands (colour flows through `ctx.color`). export/summary stay json-only. doctor's two modes each produce a Result. Done in a parallel worktree agent. `bun test` green (331 pass).


- [x] **2 · Build the output module + unified failure path**
	**Attendance:** unattended  ·  **Blocked by:** slice 1
	**Delivered:** `emit()` + `failFromError()` implemented; every command's failure path routes through the module. Shared helpers `validateEnumOrExit` (validation.ts) and `flockGuard`/`ensureCleanStore`/`mutatingPreamble` (preflight.ts) now take `OutputContext` and emit. `cli/errors.ts` has zero external callers (dead, deleted in slice 5). The one quirk — `new`'s always-plain `INVALID_TITLE` even in `--json` — preserved via a forced-plain context. Success paths untouched. `bun test` green (331 pass).

- [x] **1 · Decide the Result + output-module interface**
	**Attendance:** attended (design review)  ·  **Blocked by:** none
	**Decided:** Strict byte-for-byte preserve (error envelope stays `{error:{…}}` with no top-level `ok:false`; `new --json` keeps emitting plain text only — both warts preserved, normalising them is a separate follow-up). Output module is a side-effecting sink: `emit(result, ctx): never` writes the envelope/text + picks the exit code + exits. Colour decision (`shouldColor`) lives in the module via `outputContext(rest)`; `text(ctx)` receives it. `plainFormat: "prefixed" | "raw"` on the failure variant preserves today's two stderr shapes (raw = already-prefixed flock messages).
	**Delivered:** `src/cli/output.ts` — `OutputContext`, `CommandResult`, `outputContext()`, `emit()`. No command migrated yet; `bun test` green (331 pass).

%% kanban:settings
```
{"kanban-plugin":"board","show-checkboxes":true,"new-card-insertion-method":"append"}
```
%%
