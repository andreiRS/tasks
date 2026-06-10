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
  let port = 4317;
  if (portArg !== undefined) {
    // Guard against `Number("abc") === NaN`, negatives, and out-of-range values:
    // Bun.serve would otherwise silently bind a random ephemeral port. Port 0 is
    // valid and means "let the OS pick" (used by the test harness).
    const parsed = Number(portArg);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      process.stderr.write(
        `tasks: INVALID_PORT: --port must be an integer 0-65535; got '${portArg}'\n`,
      );
      process.exit(1);
    }
    port = parsed;
  }

  const { startBoardServer } = await import("../serve/server.ts");
  await startBoardServer({ dir, port });

  // Long-running: never resolve, so the CLI's post-handler `process.exit(0)`
  // never runs and the server keeps listening until the process is killed.
  await new Promise<never>(() => {});
}
