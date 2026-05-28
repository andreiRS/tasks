import { createTask, ensureStore, findAllTasks, findFlockOrFail, isStoreDirty, storeDir, type EditorRunner, type TaskData } from "../store.ts";
import { handleTasksError, writeJsonError, writePlainError } from "../cli/errors.ts";
import { validateEnumOrExit, validateTitle } from "../cli/validation.ts";
import { collectRepeated } from "../cli/args.ts";

const VALID_EFFORT = ["low", "medium", "high"] as const;

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");
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
    if (jsonFlag) {
      writeJsonError("CONFLICT", msg, {});
    } else {
      process.stderr.write(`tasks: CONFLICT: ${msg}\n`);
    }
    process.exit(1);
  }

  if (effortValue !== undefined) {
    validateEnumOrExit("--effort", effortValue, VALID_EFFORT, jsonFlag, "INVALID_EFFORT");
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
    process.stderr.write(`tasks: INVALID_TITLE: ${titleError}\n`);
    process.exit(1);
  }

  // Check flock availability BEFORE any store/git work.
  try {
    findFlockOrFail();
  } catch (err) {
    handleTasksError(err, jsonFlag, "raw");
  }

  const dir = storeDir(process.cwd());
  await ensureStore(dir);

  if (await isStoreDirty(dir)) {
    const msg = "store working tree is dirty; commit or discard pending changes before running mutating commands";
    if (jsonFlag) {
      writeJsonError("STORE_DIRTY", msg, {});
    } else {
      process.stderr.write(`tasks: STORE_DIRTY: ${msg}\n`);
    }
    process.exit(1);
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
        if (jsonFlag) {
          writeJsonError("UNKNOWN_UUID", msg, { uuid: ref });
        } else {
          process.stderr.write(`tasks: UNKNOWN_UUID: ${msg}\n`);
        }
        process.exit(1);
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
      if (jsonFlag) {
        writeJsonError("NO_EDITOR", msg, {});
      } else {
        writePlainError(`NO_EDITOR: ${msg}`);
      }
      process.exit(1);
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

  try {
    const id = await createTask(dir, title, {
      attendance: unattendedFlag ? "unattended" : undefined,
      effort: effortValue as "low" | "medium" | "high" | undefined,
      deps: resolvedDepUuids.length > 0 ? resolvedDepUuids : undefined,
      body: bodyContent,
      runEditor: editorRunner,
    });
    process.stdout.write(`task: new #${id}: ${title}\n`);
  } catch (err) {
    handleTasksError(err, jsonFlag);
  }
}
