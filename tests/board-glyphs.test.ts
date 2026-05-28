import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-board-glyphs-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-board-glyphs-cwd-"));
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

// ─── attended + medium glyph in board ────────────────────────────────────────

test("tasks board NO_COLOR=1 shows attended circle glyph for default task", async () => {
  await runTasks(["new", "human work"]);

  const { exitCode, stdout } = await runTasks(["board"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  expect(stdout).toContain("○");
  expect(stdout).toContain("·M");
});

// ─── unattended + high glyph in board ────────────────────────────────────────

test("tasks board NO_COLOR=1 shows unattended filled circle and high effort for agent task", async () => {
  await runTasks(["new", "bot work", "--unattended", "--effort", "high"]);

  const { exitCode, stdout } = await runTasks(["board"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  expect(stdout).toContain("●");
  expect(stdout).toContain("·H");
});

// ─── low effort in board ─────────────────────────────────────────────────────

test("tasks board NO_COLOR=1 shows low effort glyph", async () => {
  await runTasks(["new", "tiny work", "--effort", "low"]);

  const { exitCode, stdout } = await runTasks(["board"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  expect(stdout).toContain("·L");
});

// ─── --no-color still shows glyphs ───────────────────────────────────────────

test("tasks board --no-color shows glyphs without ANSI escapes", async () => {
  await runTasks(["new", "board no-color task"]);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], {
    FORCE_COLOR: "1",
  });
  expect(exitCode).toBe(0);

  expect(stdout).toContain("○");
  expect(stdout).not.toMatch(/\x1b\[/);
});

// ─── FORCE_COLOR=1 still contains glyphs ─────────────────────────────────────

test("tasks board with FORCE_COLOR=1 still includes glyphs when ANSI stripped", async () => {
  await runTasks(["new", "colorful board task"]);

  const { exitCode, stdout } = await runTasks(["board"], {
    FORCE_COLOR: "1",
    NO_COLOR: "",
  });
  expect(exitCode).toBe(0);

  const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  expect(stripped).toContain("○");
  expect(stripped).toContain("·M");
});

// ─── glyphs appear on the same line as the task card ─────────────────────────

test("tasks board NO_COLOR=1 glyphs appear on the same line as the task title", async () => {
  await runTasks(["new", "inline glyph task"]);

  const { exitCode, stdout } = await runTasks(["board"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  const taskLine = stdout
    .split("\n")
    .find((l) => l.includes("inline glyph task"));
  expect(taskLine).toBeDefined();
  expect(taskLine).toContain("○");
  expect(taskLine).toContain("·M");
});
