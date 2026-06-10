import { createTask, ensureStore, findAllTasks, findArchivedTasks, findFlockOrFail, storeDir, type EditorRunner, type TaskData } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { validateEnumOrExit, validateTitle } from "../cli/validation.ts";
import { collectRepeated, getFlagValue } from "../cli/args.ts";

const VALID_EFFORT = ["low", "medium", "high"] as const;

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);
  const unattendedFlag = rest.includes("--unattended");
  const editFlag = rest.includes("--edit");

  let effortValue: string | undefined;
  const effortIdx = rest.indexOf("--effort");
  if (effortIdx !== -1 && effortIdx + 1 < rest.length) {
    effortValue = rest[effortIdx + 1];
  }

  const depRefs = collectRepeated(rest, "--deps");

  // Body input mirrors `gh issue create`: `--body <text>` is a literal string,
  // `--body-file <path>` reads a file (`-` reads stdin), `--edit` opens $EDITOR.
  const hasBody = rest.includes("--body");
  const hasBodyFile = rest.includes("--body-file");
  const bodyValue = getFlagValue(rest, "--body");
  const bodyFileValue = getFlagValue(rest, "--body-file");

  const bodySources = [hasBody, hasBodyFile, editFlag].filter(Boolean).length;
  if (bodySources > 1) {
    const msg = "--body, --body-file, and --edit are mutually exclusive; use a single body source";
    emit({ ok: false, code: "CONFLICT", message: msg }, ctx);
  }

  const hasTitleFlag = rest.includes("--title");
  const titleFlagValue = getFlagValue(rest, "--title");

  if (effortValue !== undefined) {
    validateEnumOrExit("--effort", effortValue, VALID_EFFORT, ctx, "INVALID_EFFORT");
  }

  // Collect the title: first positional arg that isn't a flag or flag value.
  const knownFlags = new Set(["--json", "--unattended", "--edit"]);
  const flagsWithValues = new Set(["--effort", "--deps", "--body", "--body-file", "--title"]);
  const titleArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (knownFlags.has(a)) continue;
    if (flagsWithValues.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    titleArgs.push(a);
  }
  const positionalTitle = titleArgs[0];

  // `--title` is a compatibility alias for the positional form. Supplying both
  // is ambiguous, so reject it (mirrors the body-source mutual exclusion above).
  if (positionalTitle !== undefined && hasTitleFlag) {
    const msg = "positional title and --title are mutually exclusive; provide the title once";
    emit({ ok: false, code: "CONFLICT", message: msg }, ctx);
  }

  const title = positionalTitle ?? titleFlagValue ?? "";

  const titleError = validateTitle(title);
  if (titleError !== null) {
    // Pre-existing quirk: `new` reports INVALID_TITLE as plain text even in
    // --json mode (unlike `set`). Preserved byte-for-byte via a forced-plain
    // context; normalising it is a separate follow-up.
    emit({ ok: false, code: "INVALID_TITLE", message: titleError }, { json: false, color: ctx.color });
  }

  // Check flock availability BEFORE any store/git work.
  try {
    findFlockOrFail();
  } catch (err) {
    emit(failFromError(err, "raw"), ctx);
  }

  const dir = storeDir(process.cwd());
  await ensureStore(dir);

  // The dirty-tree guard runs INSIDE the flock (in createTask via
  // withTransaction({ requireClean: true })), serialized with other mutations.
  // Checking it here, outside the lock, raced concurrent `tasks new` invocations
  // into spurious STORE_DIRTY (one saw the other mid-mutation). See CLAUDE.md:
  // acquire flock, THEN dirty-tree guard.

  // Resolve --deps refs to UUIDs (need the store to exist for this).
  const resolvedDepUuids: string[] = [];
  if (depRefs.length > 0) {
    // Include archived tasks: they are resolvable terminal deps (a new task may
    // legitimately depend on already-done, archived work).
    const allTasks = [...findAllTasks(dir), ...findArchivedTasks(dir)];
    const byUuid = new Map(allTasks.map((t: TaskData) => [t.uuid, t]));
    const byId = new Map(allTasks.map((t: TaskData) => [t.id, t]));
    for (const ref of depRefs) {
      let found: TaskData | undefined;
      if (/^\d+$/.test(ref)) {
        found = byId.get(parseInt(ref, 10));
      } else {
        found = byUuid.get(ref);
      }
      if (!found) {
        const msg = `dep not found: ${ref}`;
        emit({ ok: false, code: "UNKNOWN_UUID", message: msg, details: { uuid: ref } }, ctx);
      }
      resolvedDepUuids.push(found.uuid);
    }
  }

  let bodyContent: string | undefined;
  if (hasBody) {
    bodyContent = bodyValue ?? "";
  } else if (hasBodyFile) {
    if (bodyFileValue === undefined) {
      emit({ ok: false, code: "BODY_FILE_ERROR", message: "--body-file requires a path (use - for stdin)" }, ctx);
    } else if (bodyFileValue === "-") {
      bodyContent = await new Response(Bun.stdin.stream()).text();
    } else {
      try {
        bodyContent = await Bun.file(bodyFileValue).text();
      } catch {
        emit({ ok: false, code: "BODY_FILE_ERROR", message: `cannot read --body-file: ${bodyFileValue}` }, ctx);
      }
    }
  }

  let editorRunner: EditorRunner | undefined;
  if (editFlag) {
    const editorEnv = process.env.EDITOR ?? process.env.VISUAL;
    if (!editorEnv || editorEnv.trim() === "") {
      const msg = "$EDITOR is not set; set EDITOR to your editor (e.g. vim, nano) and retry";
      emit({ ok: false, code: "NO_EDITOR", message: msg }, ctx);
    }
    editorRunner = async (filePath: string) => {
      const proc = Bun.spawn(["sh", "-c", `${editorEnv} "$1"`, "sh", filePath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return await proc.exited;
    };
  }

  let id: number;
  try {
    id = await createTask(dir, title, {
      attendance: unattendedFlag ? "unattended" : undefined,
      effort: effortValue as "low" | "medium" | "high" | undefined,
      deps: resolvedDepUuids.length > 0 ? resolvedDepUuids : undefined,
      body: bodyContent,
      runEditor: editorRunner,
    });
  } catch (err) {
    emit(failFromError(err), ctx);
  }

  // Pre-existing quirk: `new` prints the plain line even under --json and emits
  // no JSON envelope. Preserved byte-for-byte via a forced-text context.
  emit({ ok: true, text: () => `task: new #${id!}: ${title}\n` }, { json: false, color: ctx.color });
}
