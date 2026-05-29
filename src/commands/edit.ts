import { abortPendingEdits, editTask, ensureStore, findTask, storeDir, type TaskData } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { flockGuard } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);
  const abortFlag = rest.includes("--abort");
  const idOrUuid = rest.find((a) => a !== "--json" && a !== "--abort") ?? "";

  flockGuard(ctx);

  const dir = storeDir(process.cwd());
  await ensureStore(dir);

  if (abortFlag) {
    await abortPendingEdits(dir);
    process.exit(0);
  }

  if (!idOrUuid) {
    const msg = "usage: tasks edit <id|uuid> [--abort]";
    emit({ ok: false, code: "MISSING_FIELD", message: msg }, ctx);
  }

  const editorEnv = process.env.EDITOR ?? process.env.VISUAL;
  if (!editorEnv || editorEnv.trim() === "") {
    const msg = "$EDITOR is not set; set EDITOR to your editor (e.g. vim, nano) and retry";
    emit({ ok: false, code: "NO_EDITOR", message: msg }, ctx);
  }

  let editTaskBefore: TaskData | null = null;
  if (ctx.json) {
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
    if (ctx.json && editTaskBefore) {
      process.stdout.write(JSON.stringify({ ok: true, id: editTaskBefore.id, uuid: editTaskBefore.uuid, changed: editResult.kind !== "noop" }) + "\n");
    }
  } catch (err) {
    emit(failFromError(err), ctx);
  }
}
