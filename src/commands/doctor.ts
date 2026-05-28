import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveStoreDir } from "../store.ts";

/**
 * `tasks doctor` — read-only store diagnostics.
 *
 * Prints, for the current project's store:
 *   - The absolute store path.
 *   - The output of `git status --short` run inside the store.
 *   - The count of outstanding stashes in the store.
 *
 * Always exits 0. Does NOT take the flock. Does NOT validate schema.
 * Does NOT auto-create a missing store. Reports an empty/uninitialised
 * state when the store does not yet exist on disk.
 *
 * `--clean` and `--json` are intentionally not handled here; they are
 * separate slices (see ADR-0009 and docs/doctor-clean.md).
 */
export async function run(_rest: string[]): Promise<void> {
  const dir = resolveStoreDir(process.cwd());
  const hasStore = existsSync(join(dir, ".git"));

  let status = "";
  let stashes = 0;

  if (hasStore) {
    status = await gitOut(dir, ["status", "--short"]);
    const stashList = await gitOut(dir, ["stash", "list"]);
    stashes = stashList === "" ? 0 : stashList.split("\n").filter((l) => l.length > 0).length;
  }

  const out: string[] = [];
  out.push(`store: ${dir}`);
  if (!hasStore) {
    out.push("status: (store not initialised)");
  } else {
    out.push("status:");
    if (status.length > 0) {
      // Preserve git's porcelain lines verbatim so tooling can grep them.
      for (const line of status.split("\n")) {
        if (line.length > 0) out.push(line);
      }
    }
  }
  out.push(`stashes: ${stashes}`);

  process.stdout.write(out.join("\n") + "\n");
}

/**
 * Run `git -C <dir> <args>` and return its stdout (trimmed of trailing
 * newline). Returns "" on non-zero exit so callers can treat git failures
 * as a benign empty report — doctor must never throw.
 */
async function gitOut(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (code !== 0) return "";
  return stdout.replace(/\n$/, "");
}
