import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-list-auto-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-list-auto-cwd-"));
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

// ─── No glyphs / effort tags / [blocked by] remain in the new layout ─────────

test("tasks list no longer renders attendance glyphs, effort tags, or [blocked by]", async () => {
  await runTasks(["new", "human task"]);
  await runTasks(["new", "bot task", "--unattended", "--effort", "high"]);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  expect(stdout).not.toContain("○");
  expect(stdout).not.toContain("●");
  expect(stdout).not.toContain("·L");
  expect(stdout).not.toContain("·M");
  expect(stdout).not.toContain("·H");
  expect(stdout).not.toContain("[blocked by");
});

// ─── [auto] gutter present when at least one displayed task is unattended ─────

test("tasks list shows [auto] gutter on unattended rows and a blank on attended rows", async () => {
  await runTasks(["new", "human task"]);
  await runTasks(["new", "bot task", "--unattended"]);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(2);

  const botLine = lines.find((l) => l.includes("bot task"))!;
  const humanLine = lines.find((l) => l.includes("human task"))!;

  // Unattended row carries the literal [auto] gutter.
  expect(botLine).toContain("[auto]");
  // Attended row does not carry [auto], but keeps title aligned (blank gutter).
  expect(humanLine).not.toContain("[auto]");

  // Titles align: the index where the title starts is identical on both rows.
  expect(botLine.indexOf("bot task")).toBe(humanLine.indexOf("human task"));
});

// ─── gutter omitted entirely when nothing is unattended (tighter layout) ──────

test("tasks list omits the [auto] gutter when no displayed task is unattended", async () => {
  await runTasks(["new", "first task"]);
  await runTasks(["new", "second task"]);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  expect(stdout).not.toContain("[auto]");

  // Tighter layout: with idW=2 (`#1`,`#2`), col padded to 7, two 2-gaps,
  // the title begins at column 2 + 2 + 7 + 2 = 13.
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  expect(lines[0].indexOf("first task")).toBe(13);
});
