import { undoStore } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { mutatingPreamble } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);

  const dir = await mutatingPreamble(ctx);

  let revertSha: string;
  let revertedSha: string;
  try {
    ({ revertSha, revertedSha } = await undoStore(dir));
  } catch (err) {
    emit(failFromError(err), ctx);
  }

  emit(
    {
      ok: true,
      json: { ok: true, reverted: revertedSha!, revert: revertSha! },
      text: () => `tasks: undid ${revertedSha!.slice(0, 7)} (revert ${revertSha!.slice(0, 7)})\n`,
    },
    ctx,
  );
}
