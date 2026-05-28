import { COLUMNS, findTask, moveTask, type TaskData } from "../store.ts";
import { handleTasksError, writeJsonError, writePlainError } from "../cli/errors.ts";
import { mutatingPreamble } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");
  const posArgs = rest.filter((a) => a !== "--json");
  const [idOrUuid, targetColumn] = posArgs;

  if (!idOrUuid || !targetColumn) {
    const msg = "usage: tasks mv <id|uuid> <column>";
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", msg, {});
    } else {
      writePlainError(`MISSING_FIELD: ${msg}`);
    }
    process.exit(1);
  }

  if (!COLUMNS.includes(targetColumn)) {
    const msg = `unknown column: ${targetColumn}. Valid columns: ${COLUMNS.join(", ")}`;
    if (jsonFlag) {
      writeJsonError("INVALID_COLUMN", msg, { column: targetColumn, valid: COLUMNS });
    } else {
      writePlainError(`INVALID_COLUMN: ${msg}`);
    }
    process.exit(1);
  }

  const dir = await mutatingPreamble(jsonFlag);

  let mvTaskBefore: TaskData | null = null;
  if (jsonFlag) {
    mvTaskBefore = findTask(dir, idOrUuid);
  }

  try {
    await moveTask(dir, idOrUuid, targetColumn);
  } catch (err) {
    handleTasksError(err, jsonFlag);
  }

  if (jsonFlag && mvTaskBefore) {
    process.stdout.write(JSON.stringify({ ok: true, id: mvTaskBefore.id, uuid: mvTaskBefore.uuid, from: mvTaskBefore.column, to: targetColumn }) + "\n");
  }
}
