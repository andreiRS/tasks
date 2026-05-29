import { findTask, linkTask } from "../store.ts";
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

  const linkSubjectBefore = findTask(dir, subjectRef);

  try {
    await linkTask(dir, subjectRef, targetRefs);
  } catch (err) {
    emit(failFromError(err), ctx);
  }

  // linkSubjectBefore is non-null here: linkTask succeeded, so the task existed.
  const before = linkSubjectBefore!;
  const subjectAfter = findTask(dir, before.uuid);
  const beforeSet = new Set(before.deps);
  const added = (subjectAfter?.deps ?? []).filter((u) => !beforeSet.has(u));
  emit({ ok: true, json: { ok: true, id: before.id, uuid: before.uuid, added } }, ctx);
}
