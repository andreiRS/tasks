import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveStoreDir } from "../store.ts";
import { getFlagValue } from "../cli/args.ts";

/**
 * `tasks serve [--port] [--open]` — boot a localhost-only HTTP server scoped to
 * the current project's Store. Reuses the core in-process (see
 * docs/adr/0016). This is a long-running command: it does NOT route through
 * `emit()`/`process.exit()` for request handling, so a core error can never
 * kill the server. It does refuse to start (exit non-zero) when no Store exists.
 */
export async function run(rest: string[]): Promise<void> {
  const dir = resolveStoreDir(process.cwd());

  // A Store is a git-backed directory; absence of `.git` means uninitialized.
  if (!existsSync(join(dir, ".git"))) {
    process.stderr.write(
      "tasks: NOT_INITIALIZED: store not initialized; run `tasks init` to create it\n",
    );
    process.exit(1);
  }

  const portArg = getFlagValue(rest, "--port");
  const port = portArg !== undefined ? Number(portArg) : 4317;

  const { startBoardServer } = await import("../serve/server.ts");
  startBoardServer({ dir, port });

  // Long-running: never resolve, so the CLI's post-handler `process.exit(0)`
  // never runs and the server keeps listening until the process is killed.
  await new Promise<never>(() => {});
}
