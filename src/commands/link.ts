import { findTask, linkTask, type TaskData } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { mutatingPreamble } from "../cli/preflight.ts";
import { collectRepeated } from "../cli/args.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);

  const posArgs = rest.filter((a) => !a.startsWith("--"));
  const subjectRef = posArgs[0] ?? "";

  const targetRefs = collectRepeated(rest, "--depends-on");

  if (!subjectRef || targetRefs.length === 0) {
    const msg = "usage: tasks link <id|uuid> --depends-on <id|uuid>...";
    emit({ ok: false, code: "MISSING_FIELD", message: msg }, ctx);
  }

  const dir = await mutatingPreamble(ctx);

  let linkSubjectBefore: TaskData | null = null;
  if (ctx.json) {
    linkSubjectBefore = findTask(dir, subjectRef);
  }

  try {
    await linkTask(dir, subjectRef, targetRefs);
  } catch (err) {
    emit(failFromError(err), ctx);
  }

  if (ctx.json && linkSubjectBefore) {
    const subjectAfter = findTask(dir, linkSubjectBefore.uuid);
    const beforeSet = new Set(linkSubjectBefore.deps);
    const added = (subjectAfter?.deps ?? []).filter((u) => !beforeSet.has(u));
    process.stdout.write(JSON.stringify({ ok: true, id: linkSubjectBefore.id, uuid: linkSubjectBefore.uuid, added }) + "\n");
  }
}
