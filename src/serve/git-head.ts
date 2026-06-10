import { spawnSync } from "node:child_process";

/**
 * Run `git -C <dir> <args>` synchronously, returning trimmed stdout on success
 * or null on any failure. Used for cheap read-only HEAD lookups while building a
 * board snapshot; the snapshot is built per-request, so a sync call keeps the
 * code simple without blocking on the event loop for any meaningful time.
 */
export function gitCaptureSync(dir: string, args: string[]): string | null {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0 || typeof res.stdout !== "string") return null;
  return res.stdout.trim();
}
