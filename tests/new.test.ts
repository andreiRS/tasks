import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-test-"));
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
});

test("tasks new with no title exits non-zero with INVALID_TITLE", async () => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "new"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir + "/..",
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_TITLE");
});
