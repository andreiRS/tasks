import { initStore, storeDir } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { flockGuard } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);

  flockGuard(ctx);

  const dir = storeDir(process.cwd());

  try {
    const { created, path } = await initStore(dir);
    if (ctx.json) {
      process.stdout.write(JSON.stringify({ ok: true, path, created }) + "\n");
    } else if (!created) {
      process.stderr.write(`tasks: store already exists at ${path}\n`);
    }
    // On fresh init, initStore already prints the "initialized store at" notice.
  } catch (err) {
    emit(failFromError(err), ctx);
  }
}
