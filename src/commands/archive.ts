import { archiveTasks } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { mutatingPreamble } from "../cli/preflight.ts";
import { parseSinceDays } from "../cli/validation.ts";
import { getFlagValue } from "../cli/args.ts";

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
    before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  const idOrUuid = positional[0];

  if (idOrUuid && before !== undefined) {
    const msg = "tasks archive: <id|uuid> and --before are mutually exclusive";
    emit({ ok: false, code: "MISSING_FIELD", message: msg }, ctx);
  }

  const dir = await mutatingPreamble(ctx);

  try {
    const { archived } = await archiveTasks(dir, { idOrUuid, before });
    if (archived.length === 0) {
      process.stderr.write("tasks: nothing to archive\n");
      if (ctx.json) {
        process.stdout.write(JSON.stringify({ ok: true, archived: [] }) + "\n");
      }
      return;
    }
    if (ctx.json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          archived: archived.map((t) => ({ id: t.id, uuid: t.uuid, title: t.title })),
        }) + "\n",
      );
    } else {
      for (const t of archived) {
        process.stdout.write(`archived #${t.id} ${t.title}\n`);
      }
    }
  } catch (err) {
    emit(failFromError(err), ctx);
  }
}
