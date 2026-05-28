import { findTask, unlinkTask, type TaskData } from "../store.ts";
import { handleTasksError, writeJsonError, writePlainError } from "../cli/errors.ts";
import { mutatingPreamble } from "../cli/preflight.ts";
import { collectRepeated } from "../cli/args.ts";

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");

  const posArgs = rest.filter((a) => !a.startsWith("--"));
  const subjectRef = posArgs[0] ?? "";

  const targetRefs = collectRepeated(rest, "--depends-on");

  if (!subjectRef || targetRefs.length === 0) {
    const msg = "usage: tasks unlink <id|uuid> --depends-on <id|uuid>...";
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", msg, {});
    } else {
      writePlainError(`MISSING_FIELD: ${msg}`);
    }
    process.exit(1);
  }

  const dir = await mutatingPreamble(jsonFlag);

  let unlinkSubjectBefore: TaskData | null = null;
  if (jsonFlag) {
    unlinkSubjectBefore = findTask(dir, subjectRef);
  }

  try {
    await unlinkTask(dir, subjectRef, targetRefs);
  } catch (err) {
    handleTasksError(err, jsonFlag);
  }

  if (jsonFlag && unlinkSubjectBefore) {
    const subjectAfter = findTask(dir, unlinkSubjectBefore.uuid);
    const afterSet = new Set(subjectAfter?.deps ?? []);
    const removed = unlinkSubjectBefore.deps.filter((u) => !afterSet.has(u));
    process.stdout.write(JSON.stringify({ ok: true, id: unlinkSubjectBefore.id, uuid: unlinkSubjectBefore.uuid, removed }) + "\n");
  }
}
