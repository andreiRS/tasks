import { archiveTasks } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { mutatingPreamble } from "../cli/preflight.ts";
import { parseSinceDays } from "../cli/validation.ts";
import { getFlagValue } from "../cli/args.ts";
import { nowMs } from "../clock.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);
  const beforeVal = getFlagValue(rest, "--before");
  const positional = rest.filter((a, i, arr) => {
    if (a === "--json") return false;
    if (a === "--before") return false;
    if (i > 0 && arr[i - 1] === "--before") return false;
    return true;
  });

  let before: Date | undefined;
  if (beforeVal !== undefined) {
    const days = parseSinceDays(beforeVal);
    if (days === null) {
      const msg = `invalid --before value: ${beforeVal}. Expected format: <N>d (e.g. 7d, 30d)`;
      emit({ ok: false, code: "INVALID_SINCE", message: msg, details: { value: beforeVal } }, ctx);
    }
    before = new Date(nowMs() - days * 24 * 60 * 60 * 1000);
  }

  const idOrUuid = positional[0];

  if (idOrUuid && before !== undefined) {
    const msg = "tasks archive: <id|uuid> and --before are mutually exclusive";
    emit({ ok: false, code: "MISSING_FIELD", message: msg }, ctx);
  }

  const dir = await mutatingPreamble(ctx);

  let archived: Awaited<ReturnType<typeof archiveTasks>>["archived"];
  try {
    ({ archived } = await archiveTasks(dir, { idOrUuid, before }));
  } catch (err) {
    emit(failFromError(err), ctx);
  }

  if (archived!.length === 0) {
    process.stderr.write("tasks: nothing to archive\n");
    emit({ ok: true, json: { ok: true, archived: [] } }, ctx);
  }

  emit(
    {
      ok: true,
      json: { ok: true, archived: archived!.map((t) => ({ id: t.id, uuid: t.uuid, title: t.title })) },
      text: () => archived!.map((t) => `archived #${t.id} ${t.title}\n`).join(""),
    },
    ctx,
  );
}
