import { abortPendingEdits, editTask, ensureStore, findTask, storeDir, type TaskData } from "../store.ts";
import { handleTasksError, writeJsonError, writePlainError } from "../cli/errors.ts";
import { flockGuard } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");
  const abortFlag = rest.includes("--abort");
  const idOrUuid = rest.find((a) => a !== "--json" && a !== "--abort") ?? "";

  flockGuard(jsonFlag);

  const dir = storeDir(process.cwd());
  await ensureStore(dir);

  if (abortFlag) {
    await abortPendingEdits(dir);
    process.exit(0);
  }

  if (!idOrUuid) {
    const msg = "usage: tasks edit <id|uuid> [--abort]";
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", msg, {});
    } else {
      writePlainError(`MISSING_FIELD: ${msg}`);
    }
    process.exit(1);
  }

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

  let editTaskBefore: TaskData | null = null;
  if (jsonFlag) {
    editTaskBefore = findTask(dir, idOrUuid);
  }

  // Edit is EXEMPT from STORE_DIRTY by PRD design.
  try {
    const editResult = await editTask(dir, idOrUuid, async (filePath: string) => {
      const proc = Bun.spawn(["sh", "-c", `${editorEnv} "$1"`, "sh", filePath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return await proc.exited;
    });
    if (jsonFlag && editTaskBefore) {
      process.stdout.write(JSON.stringify({ ok: true, id: editTaskBefore.id, uuid: editTaskBefore.uuid, changed: editResult.kind !== "noop" }) + "\n");
    }
  } catch (err) {
    handleTasksError(err, jsonFlag);
  }
}
