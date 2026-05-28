import { existsSync } from "node:fs";
import { resolveStoreDir } from "../store.ts";
import { writeJsonError, writePlainError } from "../cli/errors.ts";

const SCHEMA_VERSION = "1";

/**
 * Capture `git rev-parse HEAD` for the given store dir. Returns the trimmed
 * SHA, or throws on git failure.
 */
async function readHeadSha(dir: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (code !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");

  // `export` always emits JSON. Require --json explicitly so we don't paint
  // a future human format into a corner.
  if (!jsonFlag) {
    writePlainError("MISSING_FIELD: tasks export requires --json");
    process.exit(1);
  }

  // Read command: never auto-init. Mirror `list`'s NOT_INITIALIZED treatment.
  const dir = resolveStoreDir(process.cwd());
  if (!existsSync(dir)) {
    writeJsonError(
      "NOT_INITIALIZED",
      "store not initialized; run `tasks init` to create it",
      {},
    );
    process.exit(1);
  }

  const headSha = await readHeadSha(dir);

  const envelope = {
    ok: true,
    schema_version: SCHEMA_VERSION,
    head_sha: headSha,
    tasks: [],
    reverse_deps: {},
  };

  process.stdout.write(JSON.stringify(envelope) + "\n");
}
