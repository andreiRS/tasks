import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-show-header-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-show-header-cwd-"));
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

// ─── Explicit attendance + effort in header ──────────────────────────────────

test("tasks show header includes Attendance and Effort full words for unattended/high task", async () => {
  const { exitCode: newExit } = await runTasks([
    "new",
    "important task",
    "--unattended",
    "--effort",
    "high",
  ]);
  expect(newExit).toBe(0);

  const { exitCode, stdout } = await runTasks(["show", "1"]);
  expect(exitCode).toBe(0);

  expect(stdout).toMatch(/Attendance:\s+unattended/);
  expect(stdout).toMatch(/Effort:\s+high/);
});

// ─── Default values appear in header ─────────────────────────────────────────

test("tasks show header shows Attendance attended and Effort medium for a default task", async () => {
  const { exitCode: newExit } = await runTasks(["new", "default task"]);
  expect(newExit).toBe(0);

  const { exitCode, stdout } = await runTasks(["show", "1"]);
  expect(exitCode).toBe(0);

  expect(stdout).toMatch(/Attendance:\s+attended/);
  expect(stdout).toMatch(/Effort:\s+medium/);
});

// ─── Low effort task ─────────────────────────────────────────────────────────

test("tasks show header shows Effort low for a low-effort task", async () => {
  const { exitCode: newExit } = await runTasks([
    "new",
    "quick task",
    "--effort",
    "low",
  ]);
  expect(newExit).toBe(0);

  const { exitCode, stdout } = await runTasks(["show", "1"]);
  expect(exitCode).toBe(0);

  expect(stdout).toMatch(/Effort:\s+low/);
});

// ─── Both fields always present ───────────────────────────────────────────────

test("tasks show always emits both Attendance and Effort lines regardless of values", async () => {
  const { exitCode: newExit } = await runTasks(["new", "any task"]);
  expect(newExit).toBe(0);

  const { exitCode, stdout } = await runTasks(["show", "1"]);
  expect(exitCode).toBe(0);

  // Both lines must appear
  expect(stdout).toMatch(/Attendance:/);
  expect(stdout).toMatch(/Effort:/);
});

// ─── --no-color does not suppress labels ─────────────────────────────────────

test("tasks show --no-color still shows Attendance and Effort labels", async () => {
  const { exitCode: newExit } = await runTasks(["new", "plain task"]);
  expect(newExit).toBe(0);

  const { exitCode, stdout } = await runTasks(["show", "1", "--no-color"], {
    FORCE_COLOR: "1",
  });
  expect(exitCode).toBe(0);

  expect(stdout).toMatch(/Attendance:\s+attended/);
  expect(stdout).toMatch(/Effort:\s+medium/);
  expect(stdout).not.toMatch(/\x1b\[/);
});
