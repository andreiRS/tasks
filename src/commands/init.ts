import { initStore, storeDir } from "../store.ts";
import { handleTasksError } from "../cli/errors.ts";
import { flockGuard } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");

  flockGuard(jsonFlag);

  const dir = storeDir(process.cwd());

  try {
    const { created, path } = await initStore(dir);
    if (jsonFlag) {
      process.stdout.write(JSON.stringify({ ok: true, path, created }) + "\n");
    } else if (!created) {
      process.stderr.write(`tasks: store already exists at ${path}\n`);
    }
    // On fresh init, initStore already prints the "initialized store at" notice.
  } catch (err) {
    handleTasksError(err, jsonFlag);
  }
}
