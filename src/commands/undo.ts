import { undoStore } from "../store.ts";
import { handleTasksError } from "../cli/errors.ts";
import { mutatingPreamble } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");

  const dir = await mutatingPreamble(jsonFlag);

  try {
    const { revertSha, revertedSha } = await undoStore(dir);
    if (jsonFlag) {
      process.stdout.write(JSON.stringify({ ok: true, reverted: revertedSha, revert: revertSha }) + "\n");
    } else {
      process.stdout.write(`tasks: undid ${revertedSha.slice(0, 7)} (revert ${revertSha.slice(0, 7)})\n`);
    }
  } catch (err) {
    handleTasksError(err, jsonFlag);
  }
}
