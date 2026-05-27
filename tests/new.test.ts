import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-cwd-"));
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
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

test("tasks new auto-initializes the store on first invocation", async () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
  const proc = Bun.spawn(["bun", "run", cliPath, "new", "hello"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  // exit code 0
  expect(exitCode).toBe(0);

  // Bun resolves symlinks in process.cwd(); do the same here so the path matches.
  // derive encoded path: literal `-` doubled to `--`, then `/` replaced with `-`
  const realCwdDir = realpathSync(cwdDir);
  const encodedCwd = realCwdDir.replace(/-/g, "--").replace(/\//g, "-");
  const storeDir = join(tasksHome, "projects", encodedCwd);

  // store directory exists
  expect(existsSync(storeDir)).toBe(true);

  // .git directory exists (it's a git repo)
  expect(existsSync(join(storeDir, ".git"))).toBe(true);

  // all six column directories exist
  for (const col of ["backlog", "ready", "doing", "blocked", "review", "done"]) {
    expect(existsSync(join(storeDir, col))).toBe(true);
  }

  // stderr contains auto-init notice
  expect(stderr).toContain("tasks: initialized store at");
});
