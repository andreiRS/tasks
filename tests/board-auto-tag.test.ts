import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-board-auto-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-board-auto-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

async function runTasks(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    env: { ...process.env, TASKS_HOME: tasksHome, ...env },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

// ─── [auto] tag replaces the old attendance/effort glyphs ────────────────────

test("tasks board shows [auto] tag for an unattended task and no glyphs", async () => {
  await runTasks(["new", "bot work", "--unattended", "--effort", "high"]);

  const { exitCode, stdout } = await runTasks(["board"], { NO_COLOR: "1", COLUMNS: "160" });
  expect(exitCode).toBe(0);

  expect(stdout).toContain("[auto]");
  // No glyphs / effort tags survive.
  expect(stdout).not.toContain("○");
  expect(stdout).not.toContain("●");
  expect(stdout).not.toContain("·H");
  expect(stdout).not.toContain("·M");
  expect(stdout).not.toContain("·L");
});

test("tasks board shows no [auto] tag for an attended task", async () => {
  await runTasks(["new", "human work"]);

  const { exitCode, stdout } = await runTasks(["board"], { NO_COLOR: "1", COLUMNS: "160" });
  expect(exitCode).toBe(0);

  expect(stdout).toContain("human work");
  expect(stdout).not.toContain("[auto]");
});

test("tasks board [auto] tag appears on the same line as the task title", async () => {
  await runTasks(["new", "inline auto task", "--unattended"]);

  const { exitCode, stdout } = await runTasks(["board"], { NO_COLOR: "1", COLUMNS: "160" });
  expect(exitCode).toBe(0);

  const taskLine = stdout.split("\n").find((l) => l.includes("inline auto task"));
  expect(taskLine).toBeDefined();
  expect(taskLine).toContain("[auto]");
});
