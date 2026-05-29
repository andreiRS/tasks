import { initStore, storeDir } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { flockGuard } from "../cli/preflight.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);

  flockGuard(ctx);

  const dir = storeDir(process.cwd());

  let created: boolean;
  let path: string;
  try {
    ({ created, path } = await initStore(dir));
  } catch (err) {
    emit(failFromError(err), ctx);
  }

  // On fresh init, initStore already prints the "initialized store at" notice.
  // The "already exists" notice goes to stderr as a side-channel (emit's
  // success text would go to stdout).
  if (!ctx.json && !created!) process.stderr.write(`tasks: store already exists at ${path!}\n`);
  emit({ ok: true, json: { ok: true, path: path!, created: created! } }, ctx);
}
