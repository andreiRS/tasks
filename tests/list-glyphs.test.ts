import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-list-glyphs-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-list-glyphs-cwd-"));
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

// ─── attended + medium = circle + M ──────────────────────────────────────────

test("tasks list NO_COLOR=1 shows attended circle glyph and medium effort for default task", async () => {
  const { exitCode: newExit } = await runTasks(["new", "attended task"]);
  expect(newExit).toBe(0);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  // attended = circle (U+25CB), medium = .M
  expect(stdout).toContain("○");
  expect(stdout).toContain("·M");
});

// ─── unattended + high = filled circle + H ───────────────────────────────────

test("tasks list NO_COLOR=1 shows unattended filled circle and high effort glyphs", async () => {
  const { exitCode: newExit } = await runTasks([
    "new",
    "agent task",
    "--unattended",
    "--effort",
    "high",
  ]);
  expect(newExit).toBe(0);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  // unattended = filled circle (U+25CF), high = .H
  expect(stdout).toContain("●");
  expect(stdout).toContain("·H");
});

// ─── low effort shows .L ─────────────────────────────────────────────────────

test("tasks list NO_COLOR=1 shows low effort glyph for low-effort task", async () => {
  const { exitCode: newExit } = await runTasks([
    "new",
    "tiny task",
    "--effort",
    "low",
  ]);
  expect(newExit).toBe(0);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  expect(stdout).toContain("·L");
});

// ─── two tasks get different glyphs ──────────────────────────────────────────

test("tasks list NO_COLOR=1 shows distinct glyphs per row for two different tasks", async () => {
  await runTasks(["new", "human task"]);
  await runTasks(["new", "bot task", "--unattended", "--effort", "high"]);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(2);

  // First row: attended circle + medium
  expect(lines[0]).toContain("○");
  expect(lines[0]).toContain("·M");

  // Second row: unattended filled circle + high
  expect(lines[1]).toContain("●");
  expect(lines[1]).toContain("·H");
});

// ─── --no-color flag shows glyphs without ANSI ───────────────────────────────

test("tasks list --no-color shows glyphs without ANSI escapes", async () => {
  await runTasks(["new", "plain glyph task"]);

  const { exitCode, stdout } = await runTasks(["list", "--no-color"], {
    FORCE_COLOR: "1",
  });
  expect(exitCode).toBe(0);

  // Glyphs must still render
  expect(stdout).toContain("○");
  // No ANSI escape codes
  expect(stdout).not.toMatch(/\x1b\[/);
});

// ─── colored output has glyphs + ANSI wrapping ───────────────────────────────

test("tasks list with FORCE_COLOR=1 still includes glyphs", async () => {
  await runTasks(["new", "colored glyph task"]);

  const { exitCode, stdout } = await runTasks(["list"], {
    FORCE_COLOR: "1",
    NO_COLOR: "",
  });
  expect(exitCode).toBe(0);

  // Strip ANSI and check glyphs remain
  const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  expect(stripped).toContain("○");
  expect(stripped).toContain("·M");
});
