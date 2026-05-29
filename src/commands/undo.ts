import { undoStore } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { mutatingPreamble } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);

  const dir = await mutatingPreamble(ctx);

  try {
    const { revertSha, revertedSha } = await undoStore(dir);
    if (ctx.json) {
      process.stdout.write(JSON.stringify({ ok: true, reverted: revertedSha, revert: revertSha }) + "\n");
    } else {
      process.stdout.write(`tasks: undid ${revertedSha.slice(0, 7)} (revert ${revertSha.slice(0, 7)})\n`);
    }
  } catch (err) {
    emit(failFromError(err), ctx);
  }
}
