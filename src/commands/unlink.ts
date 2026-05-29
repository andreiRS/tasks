import { findTask, unlinkTask, type TaskData } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { mutatingPreamble } from "../cli/preflight.ts";
import { collectRepeated } from "../cli/args.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);

  const posArgs = rest.filter((a) => !a.startsWith("--"));
  const subjectRef = posArgs[0] ?? "";

  const targetRefs = collectRepeated(rest, "--depends-on");

  if (!subjectRef || targetRefs.length === 0) {
    const msg = "usage: tasks unlink <id|uuid> --depends-on <id|uuid>...";
    emit({ ok: false, code: "MISSING_FIELD", message: msg }, ctx);
  }

  const dir = await mutatingPreamble(ctx);

  let unlinkSubjectBefore: TaskData | null = null;
  if (ctx.json) {
    unlinkSubjectBefore = findTask(dir, subjectRef);
  }

  try {
    await unlinkTask(dir, subjectRef, targetRefs);
  } catch (err) {
    emit(failFromError(err), ctx);
  }

  if (ctx.json && unlinkSubjectBefore) {
    const subjectAfter = findTask(dir, unlinkSubjectBefore.uuid);
    const afterSet = new Set(subjectAfter?.deps ?? []);
    const removed = unlinkSubjectBefore.deps.filter((u) => !afterSet.has(u));
    process.stdout.write(JSON.stringify({ ok: true, id: unlinkSubjectBefore.id, uuid: unlinkSubjectBefore.uuid, removed }) + "\n");
  }
}
