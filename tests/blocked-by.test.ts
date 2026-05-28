import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-blocked-by-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-blocked-by-cwd-"));
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

/**
 * Find the line that mentions "#<id> " (followed by a space, to avoid "#1" matching "#10").
 * Returns the first matching line or undefined.
 */
function findRowById(stdout: string, id: number): string | undefined {
  const re = new RegExp(`#${id}(?:\\b|\\s)`);
  return stdout.split("\n").find((line) => re.test(line));
}

// ─── list: human output ──────────────────────────────────────────────────────

test("list: row with two unresolved direct blockers shows [blocked by #1,#2] after O·M", async () => {
  await runTasks(["new", "blocker one"]); // #1
  await runTasks(["new", "blocker two"]); // #2
  await runTasks(["new", "subject"]); // #3
  await runTasks(["link", "3", "--depends-on", "1", "--depends-on", "2"]);

  const { exitCode, stdout } = await runTasks(["list", "--no-color"]);
  expect(exitCode).toBe(0);

  const row = findRowById(stdout, 3);
  expect(row).toBeDefined();
  expect(row!).toContain("[blocked by #1,#2]");
  // Marker must appear AFTER the O·M (glyph) cluster.
  const omIdx = row!.search(/[●○]·[LMH]/);
  const markerIdx = row!.indexOf("[blocked by");
  expect(omIdx).toBeGreaterThan(-1);
  expect(markerIdx).toBeGreaterThan(omIdx);
});

test("list: row with all blockers in done shows no marker", async () => {
  await runTasks(["new", "blocker"]); // #1
  await runTasks(["new", "subject"]); // #2
  await runTasks(["link", "2", "--depends-on", "1"]);
  await runTasks(["mv", "1", "done"]);

  const { exitCode, stdout } = await runTasks(["list", "--no-color", "--all"]);
  expect(exitCode).toBe(0);

  const row = findRowById(stdout, 2);
  expect(row).toBeDefined();
  expect(row!).not.toContain("[blocked by");
});

test("list: row in doing with an unresolved blocker shows the marker", async () => {
  await runTasks(["new", "blocker"]); // #1
  await runTasks(["new", "subject"]); // #2
  await runTasks(["link", "2", "--depends-on", "1"]);
  await runTasks(["mv", "2", "doing"]);

  const { exitCode, stdout } = await runTasks(["list", "--no-color"]);
  expect(exitCode).toBe(0);

  const row = findRowById(stdout, 2);
  expect(row).toBeDefined();
  expect(row!).toContain("[blocked by #1]");
});

test("list: row with no deps shows no marker", async () => {
  await runTasks(["new", "alone"]); // #1

  const { exitCode, stdout } = await runTasks(["list", "--no-color"]);
  expect(exitCode).toBe(0);

  const row = findRowById(stdout, 1);
  expect(row).toBeDefined();
  expect(row!).not.toContain("[blocked by");
});

test("list: marker ids are sorted ascending by short id", async () => {
  // Create 4 blockers then a subject; link in reverse order to ensure sort.
  await runTasks(["new", "b1"]); // #1
  await runTasks(["new", "b2"]); // #2
  await runTasks(["new", "b3"]); // #3
  await runTasks(["new", "subject"]); // #4
  await runTasks(["link", "4", "--depends-on", "3", "--depends-on", "1", "--depends-on", "2"]);

  const { exitCode, stdout } = await runTasks(["list", "--no-color"]);
  expect(exitCode).toBe(0);

  const row = findRowById(stdout, 4);
  expect(row).toBeDefined();
  expect(row!).toContain("[blocked by #1,#2,#3]");
});

test("list: filters done blockers but keeps unresolved ones in marker", async () => {
  await runTasks(["new", "done-blocker"]); // #1
  await runTasks(["new", "open-blocker"]); // #2
  await runTasks(["new", "subject"]); // #3
  await runTasks(["link", "3", "--depends-on", "1", "--depends-on", "2"]);
  await runTasks(["mv", "1", "done"]);

  const { exitCode, stdout } = await runTasks(["list", "--no-color", "--all"]);
  expect(exitCode).toBe(0);

  const row = findRowById(stdout, 3);
  expect(row).toBeDefined();
  expect(row!).toContain("[blocked by #2]");
  expect(row!).not.toContain("#1");
});

// ─── board: human output ─────────────────────────────────────────────────────

test("board: row with two unresolved blockers shows [blocked by #1,#2] after O·M", async () => {
  await runTasks(["new", "blocker one"]); // #1
  await runTasks(["new", "blocker two"]); // #2
  await runTasks(["new", "subject"]); // #3
  await runTasks(["link", "3", "--depends-on", "1", "--depends-on", "2"]);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"]);
  expect(exitCode).toBe(0);

  const row = findRowById(stdout, 3);
  expect(row).toBeDefined();
  expect(row!).toContain("[blocked by #1,#2]");
  const omIdx = row!.search(/[●○]·[LMH]/);
  const markerIdx = row!.indexOf("[blocked by");
  expect(omIdx).toBeGreaterThan(-1);
  expect(markerIdx).toBeGreaterThan(omIdx);
});

test("board: row with all blockers in done shows no marker", async () => {
  await runTasks(["new", "blocker"]); // #1
  await runTasks(["new", "subject"]); // #2
  await runTasks(["link", "2", "--depends-on", "1"]);
  await runTasks(["mv", "1", "done"]);

  const { exitCode, stdout } = await runTasks(["board", "--no-color", "--all"]);
  expect(exitCode).toBe(0);

  const row = findRowById(stdout, 2);
  expect(row).toBeDefined();
  expect(row!).not.toContain("[blocked by");
});

test("board: row in doing with unresolved blocker shows the marker", async () => {
  await runTasks(["new", "blocker"]); // #1
  await runTasks(["new", "subject"]); // #2
  await runTasks(["link", "2", "--depends-on", "1"]);
  await runTasks(["mv", "2", "doing"]);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"]);
  expect(exitCode).toBe(0);

  const row = findRowById(stdout, 2);
  expect(row).toBeDefined();
  expect(row!).toContain("[blocked by #1]");
});

test("board: row with no deps shows no marker", async () => {
  await runTasks(["new", "alone"]);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"]);
  expect(exitCode).toBe(0);

  const row = findRowById(stdout, 1);
  expect(row).toBeDefined();
  expect(row!).not.toContain("[blocked by");
});

// ─── list --json ─────────────────────────────────────────────────────────────

test("list --json: blockedBy contains unresolved short ids sorted ascending", async () => {
  await runTasks(["new", "b1"]); // #1
  await runTasks(["new", "b2"]); // #2
  await runTasks(["new", "subject"]); // #3
  await runTasks(["link", "3", "--depends-on", "2", "--depends-on", "1"]);

  const { exitCode, stdout } = await runTasks(["list", "--json"]);
  expect(exitCode).toBe(0);
  const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const subject = rows.find((r) => r.id === 3)!;
  expect(subject).toBeDefined();
  expect(subject.blockedBy).toEqual([1, 2]);
});

test("list --json: blockedBy is [] when nothing is blocking", async () => {
  await runTasks(["new", "alone"]);
  const { exitCode, stdout } = await runTasks(["list", "--json"]);
  expect(exitCode).toBe(0);
  const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(rows[0].blockedBy).toEqual([]);
});

test("list --json: blockedBy excludes blockers in done", async () => {
  await runTasks(["new", "done-blocker"]); // #1
  await runTasks(["new", "open-blocker"]); // #2
  await runTasks(["new", "subject"]); // #3
  await runTasks(["link", "3", "--depends-on", "1", "--depends-on", "2"]);
  await runTasks(["mv", "1", "done"]);

  const { exitCode, stdout } = await runTasks(["list", "--json", "--all"]);
  expect(exitCode).toBe(0);
  const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const subject = rows.find((r) => r.id === 3)!;
  expect(subject.blockedBy).toEqual([2]);
});

test("list --json: blockedBy element type matches id field type (number)", async () => {
  await runTasks(["new", "b1"]);
  await runTasks(["new", "subject"]);
  await runTasks(["link", "2", "--depends-on", "1"]);

  const { exitCode, stdout } = await runTasks(["list", "--json"]);
  expect(exitCode).toBe(0);
  const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const subject = rows.find((r) => r.id === 2)!;
  const arr = subject.blockedBy as unknown[];
  expect(arr.length).toBeGreaterThan(0);
  for (const v of arr) {
    expect(typeof v).toBe(typeof subject.id);
  }
});

// ─── board --json ────────────────────────────────────────────────────────────

test("board --json: each row has blockedBy with unresolved short ids", async () => {
  await runTasks(["new", "b1"]); // #1
  await runTasks(["new", "b2"]); // #2
  await runTasks(["new", "subject"]); // #3
  await runTasks(["link", "3", "--depends-on", "2", "--depends-on", "1"]);

  const { exitCode, stdout } = await runTasks(["board", "--json"]);
  expect(exitCode).toBe(0);
  const grouped = JSON.parse(stdout) as Record<string, Array<Record<string, unknown>>>;
  const backlog = grouped.backlog;
  const subject = backlog.find((r) => r.id === 3)!;
  expect(subject.blockedBy).toEqual([1, 2]);
  const b1 = backlog.find((r) => r.id === 1)!;
  expect(b1.blockedBy).toEqual([]);
});

test("board --json: blockedBy excludes done blockers", async () => {
  await runTasks(["new", "done-blocker"]); // #1
  await runTasks(["new", "open-blocker"]); // #2
  await runTasks(["new", "subject"]); // #3
  await runTasks(["link", "3", "--depends-on", "1", "--depends-on", "2"]);
  await runTasks(["mv", "1", "done"]);

  const { exitCode, stdout } = await runTasks(["board", "--json", "--all"]);
  expect(exitCode).toBe(0);
  const grouped = JSON.parse(stdout) as Record<string, Array<Record<string, unknown>>>;
  const subject = grouped.backlog.find((r) => r.id === 3)!;
  expect(subject.blockedBy).toEqual([2]);
});

test("board --json: blockedBy element type matches id field type (number)", async () => {
  await runTasks(["new", "b1"]);
  await runTasks(["new", "subject"]);
  await runTasks(["link", "2", "--depends-on", "1"]);

  const { exitCode, stdout } = await runTasks(["board", "--json"]);
  expect(exitCode).toBe(0);
  const grouped = JSON.parse(stdout) as Record<string, Array<Record<string, unknown>>>;
  const subject = grouped.backlog.find((r) => r.id === 2)!;
  const arr = subject.blockedBy as unknown[];
  expect(arr.length).toBeGreaterThan(0);
  for (const v of arr) {
    expect(typeof v).toBe(typeof subject.id);
  }
});
