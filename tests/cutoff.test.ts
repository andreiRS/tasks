import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS } from "../src/store.ts";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-cutoff-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-cutoff-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

async function runTasks(
  args: string[],
  env: Record<string, string> = {}
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

/**
 * Plant a task file directly into a column directory.
 * `updatedAt` controls whether it appears within/beyond the cutoff.
 */
function plantTask(
  storeDir: string,
  column: string,
  id: number,
  title: string,
  updatedAt: string
): void {
  const colDir = join(storeDir, column);
  mkdirSync(colDir, { recursive: true });
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = `${id}-${slug}.md`;
  const createdAt = "2026-01-01T00:00:00.000Z";
  const uuid = `${"a".repeat(8)}-${id.toString().padStart(4, "0")}-4000-8000-${"b".repeat(12)}`;
  const content = `---\nid: ${id}\nuuid: ${uuid}\ntitle: ${title}\ncreated_at: ${createdAt}\nupdated_at: ${updatedAt}\n---\n`;
  writeFileSync(join(colDir, filename), content, "utf-8");
}

/**
 * Initialize a bare store (git init + column dirs + initial commit).
 */
async function initBareStore(storeDir: string): Promise<void> {
  mkdirSync(storeDir, { recursive: true });
  for (const col of COLUMNS) {
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

function deriveStorePath(tasksHome: string, cwd: string): string {
  const realCwd = realpathSync(cwd);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

async function gitAdd(storeDir: string): Promise<void> {
  const git = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: storeDir, stdout: "pipe", stderr: "pipe" }).exited;
  await git(["add", "."]);
  await git(["commit", "-m", "seed tasks"]);
}

// Timestamps computed relative to now so tests stay valid indefinitely.
const RECENT_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();   // 2 days ago -- within 7-day window
const OLD_DATE = new Date(Date.now() - 26 * 24 * 60 * 60 * 1000).toISOString();     // 26 days ago -- outside 7-day window, inside 30-day window
const VERY_RECENT_DATE = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();   // 1 hour ago -- within 1-day window
const ANCIENT_DATE = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days ago -- outside 30-day window
const TODAY_DATE = new Date(Date.now() - 30 * 60 * 1000).toISOString();             // 30 minutes ago -- "today", used with --since 0d

// ─── Default 7-day cutoff: list ──────────────────────────────────────────────

test("tasks list: done tasks older than 7 days are hidden by default (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "old done task", OLD_DATE);
  plantTask(storeDir, "done", 2, "recent done task", RECENT_DATE);
  plantTask(storeDir, "backlog", 3, "backlog task", OLD_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["list", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const titles = parsed.map((t) => t.title);

  // Old done task must be hidden
  expect(titles).not.toContain("old done task");
  // Recent done task must appear
  expect(titles).toContain("recent done task");
  // Backlog task (non-done) must appear regardless of age
  expect(titles).toContain("backlog task");
});

test("tasks list: done tasks older than 7 days are hidden by default (human output)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "old done task", OLD_DATE);
  plantTask(storeDir, "done", 2, "recent done task", RECENT_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["list"]);
  expect(exitCode).toBe(0);

  expect(stdout).not.toContain("old done task");
  expect(stdout).toContain("recent done task");
});

// ─── --all flag bypasses cutoff: list ────────────────────────────────────────

test("tasks list --all shows all done tasks regardless of age (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "old done task", OLD_DATE);
  plantTask(storeDir, "done", 2, "recent done task", RECENT_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["list", "--all", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const titles = parsed.map((t) => t.title);
  expect(titles).toContain("old done task");
  expect(titles).toContain("recent done task");
});

test("tasks list --all shows all done tasks regardless of age (human output)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "old done task", OLD_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["list", "--all"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("old done task");
});

// ─── --since <duration> overrides cutoff: list ───────────────────────────────

test("tasks list --since 30d shows done tasks within 30 days (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  // OLD_DATE is 26 days ago; within 30d window
  plantTask(storeDir, "done", 1, "old done task", OLD_DATE);
  // Very old: more than 30 days ago
  plantTask(storeDir, "done", 2, "ancient done task", ANCIENT_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["list", "--since", "30d", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const titles = parsed.map((t) => t.title);
  expect(titles).toContain("old done task");
  expect(titles).not.toContain("ancient done task");
});

test("tasks list --since 1d hides done tasks older than 1 day (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "two day old task", RECENT_DATE); // 2 days old
  plantTask(storeDir, "done", 2, "very recent task", VERY_RECENT_DATE); // 1 hour ago -- within 1-day window
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["list", "--since", "1d", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const titles = parsed.map((t) => t.title);
  expect(titles).not.toContain("two day old task");
  expect(titles).toContain("very recent task");
});

// ─── Cutoff applies only to done column: list ─────────────────────────────────

test("tasks list: non-done columns are never filtered by cutoff (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  // Old tasks in non-done columns: must still appear
  plantTask(storeDir, "backlog", 1, "old backlog", OLD_DATE);
  plantTask(storeDir, "ready", 2, "old ready", OLD_DATE);
  plantTask(storeDir, "doing", 3, "old doing", OLD_DATE);
  plantTask(storeDir, "blocked", 4, "old blocked", OLD_DATE);
  plantTask(storeDir, "review", 5, "old review", OLD_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["list", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const titles = parsed.map((t) => t.title);
  expect(titles).toContain("old backlog");
  expect(titles).toContain("old ready");
  expect(titles).toContain("old doing");
  expect(titles).toContain("old blocked");
  expect(titles).toContain("old review");
});

// ─── Edge: --since 0d hides all done tasks ───────────────────────────────────

test("tasks list --since 0d hides all done tasks (cutoff value of 0) (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "done task today", TODAY_DATE);
  plantTask(storeDir, "backlog", 2, "backlog task", OLD_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["list", "--since", "0d", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const titles = parsed.map((t) => t.title);
  // done column entirely hidden when window is 0 days
  expect(titles).not.toContain("done task today");
  // non-done still visible
  expect(titles).toContain("backlog task");
});

// ─── Invalid --since value ────────────────────────────────────────────────────

test("tasks list --since with invalid value exits non-zero (plain)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);

  const { exitCode, stderr } = await runTasks(["list", "--since", "abc"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_SINCE");
});

test("tasks list --since with negative value exits non-zero (plain)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);

  const { exitCode, stderr } = await runTasks(["list", "--since", "-1d"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_SINCE");
});

test("tasks list --since with invalid value exits non-zero (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);

  const { exitCode, stderr } = await runTasks(["list", "--since", "abc", "--json"]);
  expect(exitCode).not.toBe(0);
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const error = parsed.error as Record<string, unknown>;
  expect(error.code).toBe("INVALID_SINCE");
});

// ─── Default 7-day cutoff: board ─────────────────────────────────────────────

test("tasks board: done tasks older than 7 days are hidden by default (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "old done task", OLD_DATE);
  plantTask(storeDir, "done", 2, "recent done task", RECENT_DATE);
  plantTask(storeDir, "backlog", 3, "backlog task", OLD_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown[]>;
  const doneTasks = parsed.done as Array<Record<string, unknown>>;
  const doneTitles = doneTasks.map((t) => t.title);

  expect(doneTitles).not.toContain("old done task");
  expect(doneTitles).toContain("recent done task");

  // Backlog not affected
  const backlogTasks = parsed.backlog as Array<Record<string, unknown>>;
  const backlogTitles = backlogTasks.map((t) => t.title);
  expect(backlogTitles).toContain("backlog task");
});

test("tasks board: done tasks older than 7 days are hidden by default (human output)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "old done task", OLD_DATE);
  plantTask(storeDir, "done", 2, "recent done task", RECENT_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["board"]);
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("old done task");
  expect(stdout).toContain("recent done task");
});

// ─── --all flag bypasses cutoff: board ───────────────────────────────────────

test("tasks board --all shows all done tasks regardless of age (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "old done task", OLD_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--all", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown[]>;
  const doneTasks = parsed.done as Array<Record<string, unknown>>;
  const doneTitles = doneTasks.map((t) => t.title);
  expect(doneTitles).toContain("old done task");
});

// ─── --since <duration> overrides cutoff: board ──────────────────────────────

test("tasks board --since 30d shows done tasks within 30 days (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "old done task", OLD_DATE); // 26 days ago
  plantTask(storeDir, "done", 2, "ancient done task", ANCIENT_DATE);
  await gitAdd(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--since", "30d", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown[]>;
  const doneTitles = (parsed.done as Array<Record<string, unknown>>).map((t) => t.title);
  expect(doneTitles).toContain("old done task");
  expect(doneTitles).not.toContain("ancient done task");
});

// ─── TASKS_NOW pins the clock (deterministic cutoff) ─────────────────────────

const PINNED_DONE = "2026-05-27T10:00:00.000Z";

test("tasks list: TASKS_NOW pins the cutoff clock so a fixed done date stays in-window", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "pinned done task", PINNED_DONE);
  await gitAdd(storeDir);

  // "now" pinned to the same day -> 0 days old -> within the 7-day window.
  const { exitCode, stdout } = await runTasks(["list", "--json"], {
    TASKS_NOW: "2026-05-27T12:00:00.000Z",
  });
  expect(exitCode).toBe(0);
  const titles = (JSON.parse(stdout) as Array<Record<string, unknown>>).map((t) => t.title);
  expect(titles).toContain("pinned done task");
});

test("tasks list: TASKS_NOW pins the cutoff clock so an old done date is hidden", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "done", 1, "pinned done task", PINNED_DONE);
  await gitAdd(storeDir);

  // "now" pinned 30 days later -> outside the 7-day window -> hidden.
  const { exitCode, stdout } = await runTasks(["list", "--json"], {
    TASKS_NOW: "2026-06-26T12:00:00.000Z",
  });
  expect(exitCode).toBe(0);
  const titles = (JSON.parse(stdout) as Array<Record<string, unknown>>).map((t) => t.title);
  expect(titles).not.toContain("pinned done task");
});

// ─── Invalid --since value: board ────────────────────────────────────────────

test("tasks board --since with invalid value exits non-zero and emits INVALID_SINCE (plain)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);

  const { exitCode, stderr } = await runTasks(["board", "--since", "xyz"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_SINCE");
});

test("tasks board --since with invalid value exits non-zero and emits INVALID_SINCE (--json)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);

  const { exitCode, stderr } = await runTasks(["board", "--since", "xyz", "--json"]);
  expect(exitCode).not.toBe(0);
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const error = parsed.error as Record<string, unknown>;
  expect(error.code).toBe("INVALID_SINCE");
});
