import { findTask, linkTask, type TaskData } from "../store.ts";
import { handleTasksError, writeJsonError, writePlainError } from "../cli/errors.ts";
import { mutatingPreamble } from "../cli/preflight.ts";
import { collectRepeated } from "../cli/args.ts";

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");

  const posArgs = rest.filter((a) => !a.startsWith("--"));
  const subjectRef = posArgs[0] ?? "";

  const targetRefs = collectRepeated(rest, "--depends-on");

  if (!subjectRef || targetRefs.length === 0) {
    const msg = "usage: tasks link <id|uuid> --depends-on <id|uuid>...";
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", msg, {});
    } else {
      writePlainError(`MISSING_FIELD: ${msg}`);
    }
    process.exit(1);
  }

  const dir = await mutatingPreamble(jsonFlag);

  let linkSubjectBefore: TaskData | null = null;
  if (jsonFlag) {
    linkSubjectBefore = findTask(dir, subjectRef);
  }

  try {
    await linkTask(dir, subjectRef, targetRefs);
  } catch (err) {
    handleTasksError(err, jsonFlag);
  }

  if (jsonFlag && linkSubjectBefore) {
    const subjectAfter = findTask(dir, linkSubjectBefore.uuid);
    const beforeSet = new Set(linkSubjectBefore.deps);
    const added = (subjectAfter?.deps ?? []).filter((u) => !beforeSet.has(u));
    process.stdout.write(JSON.stringify({ ok: true, id: linkSubjectBefore.id, uuid: linkSubjectBefore.uuid, added }) + "\n");
  }
}
