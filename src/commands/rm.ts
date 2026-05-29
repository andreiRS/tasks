import { removeTask } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { mutatingPreamble } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);
  const forceFlag = rest.includes("--force");
  const idOrUuid = rest.find((a) => a !== "--json" && a !== "--force") ?? "";

  if (!idOrUuid) {
    const msg = "usage: tasks rm <id|uuid> [--force]";
    emit({ ok: false, code: "MISSING_FIELD", message: msg }, ctx);
  }

  const dir = await mutatingPreamble(ctx);

  let rmTask: Awaited<ReturnType<typeof removeTask>>["task"];
  let affected: Awaited<ReturnType<typeof removeTask>>["affected"];
  try {
    ({ task: rmTask, affected } = await removeTask(dir, idOrUuid, forceFlag));
  } catch (err) {
    emit(failFromError(err), ctx);
  }

  // affected stderr side-channel runs in BOTH modes.
  for (const t of affected!) {
    process.stderr.write(`affected: #${t.id} ${t.title}\n`);
  }
  emit({ ok: true, json: { ok: true, id: rmTask!.id, uuid: rmTask!.uuid, forced: forceFlag, cascaded: affected!.map((t) => t.uuid) } }, ctx);
}
