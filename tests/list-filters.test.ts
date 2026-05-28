import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-lf-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-lf-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

async function runTasks(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    env: { ...process.env, TASKS_HOME: tasksHome },
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

/** Derive the store path from tasksHome + encoded cwd (resolves macOS symlinks). */
function deriveStorePath(): string {
  const realCwd = realpathSync(cwdDir);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

/** Initialize a bare store (git init + column dirs + initial commit). */
async function initBareStore(storeDir: string): Promise<void> {
  mkdirSync(storeDir, { recursive: true });
  for (const col of ["backlog", "ready", "doing", "blocked", "review", "done"]) {
    mkdirSync(join(storeDir, col), { recursive: true });
  }
  const spawn = (args: string[]) =>
    Bun.spawn(args, { cwd: storeDir, stdout: "pipe", stderr: "pipe" }).exited;
  await spawn(["git", "init"]);
  writeFileSync(join(storeDir, ".gitignore"), ".tasks-lock\n", "utf-8");
  await spawn(["git", "add", ".gitignore"]);
  await spawn(["git", "commit", "-m", "init"]);
  writeFileSync(join(storeDir, "meta.yaml"), "next_id: 1\n", "utf-8");
  await spawn(["git", "add", "meta.yaml"]);
  await spawn(["git", "commit", "-m", "meta"]);
}

/** Plant a task file with explicit attendance and effort into a column dir. */
function plantTask(
  storeDir: string,
  column: string,
  id: number,
  title: string,
  attendance: string,
  effort: string,
): void {
  const colDir = join(storeDir, column);
  mkdirSync(colDir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filename = `${id}-${slug}.md`;
  const now = "2026-05-27T10:00:00.000Z";
  const uuid = `${"a".repeat(8)}-${id.toString().padStart(4, "0")}-4000-8000-${"b".repeat(12)}`;
  const content = [
    "---",
    `id: ${id}`,
    `uuid: ${uuid}`,
    `title: ${title}`,
    `attendance: ${attendance}`,
    `effort: ${effort}`,
    `created_at: ${now}`,
    `updated_at: ${now}`,
    "deps: []",
    "---",
    "",
  ].join("\n");
  writeFileSync(join(colDir, filename), content, "utf-8");
}

/** Commit all changes in the store dir. */
async function gitCommitAll(storeDir: string, message: string): Promise<void> {
  const git = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: storeDir, stdout: "pipe", stderr: "pipe" }).exited;
  await git(["add", "."]);
  await git(["commit", "-m", message]);
}

// ─── --attendance filter ─────────────────────────────────────────────────────

test("tasks list --attendance attended returns only attended tasks (--json)", async () => {
  const storeDir = deriveStorePath();
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "attended task", "attended", "medium");
  plantTask(storeDir, "backlog", 2, "unattended task", "unattended", "medium");
  await gitCommitAll(storeDir, "seed");

  const { exitCode, stdout } = await runTasks(["list", "--attendance", "attended", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed).toHaveLength(1);
  expect(parsed[0].title).toBe("attended task");
  expect(parsed[0].attendance).toBe("attended");
});

test("tasks list --attendance unattended returns only unattended tasks (--json)", async () => {
  const storeDir = deriveStorePath();
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "attended task", "attended", "medium");
  plantTask(storeDir, "backlog", 2, "unattended task", "unattended", "medium");
  plantTask(storeDir, "doing", 3, "another unattended", "unattended", "high");
  await gitCommitAll(storeDir, "seed");

  const { exitCode, stdout } = await runTasks(["list", "--attendance", "unattended", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed).toHaveLength(2);
  for (const t of parsed) {
    expect(t.attendance).toBe("unattended");
  }
});

test("tasks list --attendance attended returns only attended tasks (human output)", async () => {
  const storeDir = deriveStorePath();
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "attended task", "attended", "medium");
  plantTask(storeDir, "backlog", 2, "unattended task", "unattended", "medium");
  await gitCommitAll(storeDir, "seed");

  const { exitCode, stdout } = await runTasks(["list", "--attendance", "attended"]);
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("attended task");
  expect(lines[0]).not.toContain("unattended task");
});

// ─── --effort filter ─────────────────────────────────────────────────────────

test("tasks list --effort low returns only low-effort tasks (--json)", async () => {
  const storeDir = deriveStorePath();
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "low effort task", "attended", "low");
  plantTask(storeDir, "backlog", 2, "medium effort task", "attended", "medium");
  plantTask(storeDir, "backlog", 3, "high effort task", "attended", "high");
  await gitCommitAll(storeDir, "seed");

  const { exitCode, stdout } = await runTasks(["list", "--effort", "low", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(parsed).toHaveLength(1);
  expect(parsed[0].title).toBe("low effort task");
  expect(parsed[0].effort).toBe("low");
});

test("tasks list --effort high returns only high-effort tasks (--json)", async () => {
  const storeDir = deriveStorePath();
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "low effort task", "attended", "low");
  plantTask(storeDir, "backlog", 2, "medium effort task", "attended", "medium");
  plantTask(storeDir, "doing", 3, "high effort task", "attended", "high");
  await gitCommitAll(storeDir, "seed");

  const { exitCode, stdout } = await runTasks(["list", "--effort", "high", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(parsed).toHaveLength(1);
  expect(parsed[0].title).toBe("high effort task");
  expect(parsed[0].effort).toBe("high");
});

test("tasks list --effort medium returns only medium-effort tasks (human output)", async () => {
  const storeDir = deriveStorePath();
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "low effort task", "attended", "low");
  plantTask(storeDir, "backlog", 2, "medium effort task", "attended", "medium");
  plantTask(storeDir, "backlog", 3, "high effort task", "attended", "high");
  await gitCommitAll(storeDir, "seed");

  const { exitCode, stdout } = await runTasks(["list", "--effort", "medium"]);
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("medium effort task");
  expect(lines[0]).not.toContain("low effort task");
  expect(lines[0]).not.toContain("high effort task");
});

// ─── AND composition: both --attendance and --effort ─────────────────────────

test("tasks list --attendance unattended --effort high narrows by AND (--json)", async () => {
  const storeDir = deriveStorePath();
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "attended high", "attended", "high");
  plantTask(storeDir, "backlog", 2, "unattended low", "unattended", "low");
  plantTask(storeDir, "backlog", 3, "unattended high", "unattended", "high");
  plantTask(storeDir, "doing", 4, "attended low", "attended", "low");
  await gitCommitAll(storeDir, "seed");

  const { exitCode, stdout } = await runTasks([
    "list",
    "--attendance", "unattended",
    "--effort", "high",
    "--json",
  ]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(parsed).toHaveLength(1);
  expect(parsed[0].title).toBe("unattended high");
  expect(parsed[0].attendance).toBe("unattended");
  expect(parsed[0].effort).toBe("high");
});

test("tasks list --attendance and --effort compose with --column (--json)", async () => {
  const storeDir = deriveStorePath();
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "backlog unattended high", "unattended", "high");
  plantTask(storeDir, "doing", 2, "doing unattended high", "unattended", "high");
  plantTask(storeDir, "backlog", 3, "backlog attended medium", "attended", "medium");
  await gitCommitAll(storeDir, "seed");

  const { exitCode, stdout } = await runTasks([
    "list",
    "--column", "backlog",
    "--attendance", "unattended",
    "--effort", "high",
    "--json",
  ]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(parsed).toHaveLength(1);
  expect(parsed[0].title).toBe("backlog unattended high");
  expect(parsed[0].column).toBe("backlog");
});

// ─── Empty results ────────────────────────────────────────────────────────────

test("tasks list --attendance attended with no matching tasks exits 0 and returns [] (--json)", async () => {
  const storeDir = deriveStorePath();
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "unattended task", "unattended", "medium");
  await gitCommitAll(storeDir, "seed");

  const { exitCode, stdout } = await runTasks(["list", "--attendance", "attended", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed).toHaveLength(0);
});

test("tasks list --effort low with no matching tasks exits 0 and prints (no tasks) (human)", async () => {
  const storeDir = deriveStorePath();
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "high effort task", "attended", "high");
  await gitCommitAll(storeDir, "seed");

  const { exitCode, stdout } = await runTasks(["list", "--effort", "low"]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("(no tasks)");
});

// ─── Invalid enum value errors ────────────────────────────────────────────────

test("tasks list --attendance with invalid value exits non-zero with INVALID_ATTENDANCE (plain)", async () => {
  // Need an initialized store
  await runTasks(["new", "seed task"]);

  const { exitCode, stderr } = await runTasks(["list", "--attendance", "whenever"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_ATTENDANCE");
});

test("tasks list --attendance with invalid value exits non-zero with INVALID_ATTENDANCE (--json)", async () => {
  await runTasks(["new", "seed task"]);

  const { exitCode, stderr } = await runTasks(["list", "--attendance", "whenever", "--json"]);
  expect(exitCode).not.toBe(0);

  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const error = parsed.error as Record<string, unknown>;
  expect(error.code).toBe("INVALID_ATTENDANCE");
});

test("tasks list --effort with invalid value exits non-zero with INVALID_EFFORT (plain)", async () => {
  await runTasks(["new", "seed task"]);

  const { exitCode, stderr } = await runTasks(["list", "--effort", "extreme"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_EFFORT");
});

test("tasks list --effort with invalid value exits non-zero with INVALID_EFFORT (--json)", async () => {
  await runTasks(["new", "seed task"]);

  const { exitCode, stderr } = await runTasks(["list", "--effort", "extreme", "--json"]);
  expect(exitCode).not.toBe(0);

  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const error = parsed.error as Record<string, unknown>;
  expect(error.code).toBe("INVALID_EFFORT");
});
