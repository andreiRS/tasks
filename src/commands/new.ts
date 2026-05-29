import { createTask, ensureStore, findAllTasks, findFlockOrFail, isStoreDirty, storeDir, type EditorRunner, type TaskData } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { validateEnumOrExit, validateTitle } from "../cli/validation.ts";
import { collectRepeated } from "../cli/args.ts";

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

  let bodyFromStdin = false;
  const bodyIdx = rest.indexOf("--body");
  if (bodyIdx !== -1 && bodyIdx + 1 < rest.length && rest[bodyIdx + 1] === "-") {
    bodyFromStdin = true;
  }

  if (editFlag && bodyFromStdin) {
    const msg = "--edit and --body - are mutually exclusive; use one or the other";
    emit({ ok: false, code: "CONFLICT", message: msg }, ctx);
  }

  if (effortValue !== undefined) {
    validateEnumOrExit("--effort", effortValue, VALID_EFFORT, ctx, "INVALID_EFFORT");
  }

  // Collect the title: first positional arg that isn't a flag or flag value.
  const knownFlags = new Set(["--json", "--unattended", "--edit"]);
  const flagsWithValues = new Set(["--effort", "--deps", "--body"]);
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
  const title = titleArgs[0] ?? "";

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

  if (await isStoreDirty(dir)) {
    const msg = "store working tree is dirty; commit or discard pending changes before running mutating commands";
    emit({ ok: false, code: "STORE_DIRTY", message: msg }, ctx);
  }

  // Resolve --deps refs to UUIDs (need the store to exist for this).
  const resolvedDepUuids: string[] = [];
  if (depRefs.length > 0) {
    const allTasks = findAllTasks(dir);
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
  if (bodyFromStdin) {
    bodyContent = await new Response(Bun.stdin.stream()).text();
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
