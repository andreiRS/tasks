import { removeTask } from "../store.ts";
import { handleTasksError, writeJsonError, writePlainError } from "../cli/errors.ts";
import { mutatingPreamble } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");
  const forceFlag = rest.includes("--force");
  const idOrUuid = rest.find((a) => a !== "--json" && a !== "--force") ?? "";

  if (!idOrUuid) {
    const msg = "usage: tasks rm <id|uuid> [--force]";
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", msg, {});
    } else {
      writePlainError(`MISSING_FIELD: ${msg}`);
    }
    process.exit(1);
  }

  const dir = await mutatingPreamble(jsonFlag);

  try {
    const { task: rmTask, affected } = await removeTask(dir, idOrUuid, forceFlag);
    for (const t of affected) {
      process.stderr.write(`affected: #${t.id} ${t.title}\n`);
    }
    if (jsonFlag) {
      process.stdout.write(JSON.stringify({ ok: true, id: rmTask.id, uuid: rmTask.uuid, forced: forceFlag, cascaded: affected.map((t) => t.uuid) }) + "\n");
    }
  } catch (err) {
    handleTasksError(err, jsonFlag);
  }
}
