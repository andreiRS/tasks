import { COLUMNS, findTask, moveTask } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { mutatingPreamble } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);
  const posArgs = rest.filter((a) => a !== "--json");
  const [idOrUuid, targetColumn] = posArgs;

  if (!idOrUuid || !targetColumn) {
    const msg = "usage: tasks mv <id|uuid> <column>";
    emit({ ok: false, code: "MISSING_FIELD", message: msg }, ctx);
  }

  if (!COLUMNS.includes(targetColumn)) {
    const msg = `unknown column: ${targetColumn}. Valid columns: ${COLUMNS.join(", ")}`;
    emit({ ok: false, code: "INVALID_COLUMN", message: msg, details: { column: targetColumn, valid: COLUMNS } }, ctx);
  }

  const dir = await mutatingPreamble(ctx);

  const mvTaskBefore = findTask(dir, idOrUuid);

  try {
    await moveTask(dir, idOrUuid, targetColumn);
  } catch (err) {
    emit(failFromError(err), ctx);
  }

  // mvTaskBefore is non-null here: moveTask succeeded, so the task existed.
  emit({ ok: true, json: { ok: true, id: mvTaskBefore!.id, uuid: mvTaskBefore!.uuid, from: mvTaskBefore!.column, to: targetColumn } }, ctx);
}
