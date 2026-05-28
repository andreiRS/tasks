import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-summary-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-summary-cwd-"));
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

// ─── Slice 1: empty store ────────────────────────────────────────────────────

test("tasks summary --json on initialized empty store returns envelope with zero counts and empty arrays", async () => {
  const init = await runTasks(["init", "--json"]);
  expect(init.exitCode).toBe(0);

  const { exitCode, stdout, stderr } = await runTasks(["summary", "--json"]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(parsed.ok).toBe(true);
  expect(parsed.schema_version).toBe("1");
  expect(typeof parsed.head_sha).toBe("string");
  expect((parsed.head_sha as string).length).toBeGreaterThanOrEqual(40);

  const counts = parsed.counts as Record<string, number>;
  expect(counts.backlog).toBe(0);
  expect(counts.ready).toBe(0);
  expect(counts.doing).toBe(0);
  expect(counts.blocked).toBe(0);
  expect(counts.review).toBe(0);
  expect(counts.done).toBe(0);
  expect(counts.archive).toBe(0);

  expect(parsed.recent).toEqual([]);
  expect(parsed.stale).toEqual([]);
});

test("tasks summary --json requires --json flag; without it exits non-zero with MISSING_FIELD", async () => {
  const init = await runTasks(["init"]);
  expect(init.exitCode).toBe(0);

  const { exitCode, stderr } = await runTasks(["summary"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("MISSING_FIELD");
});

// ─── Slice 2: counts reflect tasks across columns and archive ─────────────────

test("tasks summary --json counts reflects tasks in each column and archive", async () => {
  // Create several tasks and move them into different columns.
  await runTasks(["new", "task-backlog"]);       // stays in backlog
  await runTasks(["new", "task-ready"]);
  await runTasks(["new", "task-doing"]);
  await runTasks(["new", "task-blocked"]);
  await runTasks(["new", "task-review"]);
  await runTasks(["new", "task-done"]);
  await runTasks(["new", "task-archive"]);       // will be archived

  await runTasks(["mv", "2", "ready"]);
  await runTasks(["mv", "3", "doing"]);
  await runTasks(["mv", "4", "blocked"]);
  await runTasks(["mv", "5", "review"]);
  await runTasks(["mv", "6", "done"]);
  await runTasks(["mv", "7", "done"]);
  await runTasks(["archive", "7"]);

  const { exitCode, stdout } = await runTasks(["summary", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const counts = parsed.counts as Record<string, number>;
  expect(counts.backlog).toBe(1);
  expect(counts.ready).toBe(1);
  expect(counts.doing).toBe(1);
  expect(counts.blocked).toBe(1);
  expect(counts.review).toBe(1);
  expect(counts.done).toBe(1);
  expect(counts.archive).toBe(1);
});

// ─── Slice 3: recent returns up to 10 live tasks by updated_at desc ──────────

test("tasks summary --json recent returns minimal stub shape, live tasks only, sorted by updated_at desc", async () => {
  // Create a task and archive it; it must not appear in recent.
  await runTasks(["new", "archived-task"]);
  await runTasks(["mv", "1", "done"]);
  await runTasks(["archive", "1"]);

  // Create a live task.
  await runTasks(["new", "live-task"]);

  const { exitCode, stdout } = await runTasks(["summary", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const recent = parsed.recent as Array<Record<string, unknown>>;

  // Only the live task should appear in recent.
  expect(recent).toHaveLength(1);

  const stub = recent[0];
  expect(typeof stub.id).toBe("number");
  expect(typeof stub.uuid).toBe("string");
  expect(typeof stub.title).toBe("string");
  expect(typeof stub.column).toBe("string");
  expect(typeof stub.updated_at).toBe("string");

  // No body, no deps, no acceptance_criteria in stub.
  expect(stub.body).toBeUndefined();
  expect(stub.deps).toBeUndefined();
  expect(stub.acceptance_criteria).toBeUndefined();
});

test("tasks summary --json recent is limited to 10 and sorted by updated_at descending", async () => {
  // Create 12 tasks; most recently touched should appear first.
  for (let i = 1; i <= 12; i++) {
    await runTasks(["new", `task-${i}`]);
  }
  // Move tasks 1-12 to ready so updated_at differs, oldest first by default creation.
  // Move in ascending order so task-12 is touched last (most recent).
  for (let i = 1; i <= 12; i++) {
    await runTasks(["mv", String(i), "ready"]);
  }

  const { exitCode, stdout } = await runTasks(["summary", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const recent = parsed.recent as Array<Record<string, unknown>>;

  // Should be capped at 10.
  expect(recent).toHaveLength(10);

  // Should be sorted descending by updated_at (id 12 first, id 3 last).
  const ids = recent.map((t) => t.id as number);
  expect(ids[0]).toBe(12);
  expect(ids[9]).toBe(3);

  // Verify descending order of updated_at.
  for (let i = 0; i < recent.length - 1; i++) {
    const a = new Date(recent[i].updated_at as string).getTime();
    const b = new Date(recent[i + 1].updated_at as string).getTime();
    expect(a).toBeGreaterThanOrEqual(b);
  }
});

// ─── Slice 4: --recent N flag ─────────────────────────────────────────────────

test("tasks summary --json --recent N overrides the 10-task default", async () => {
  for (let i = 1; i <= 5; i++) {
    await runTasks(["new", `task-${i}`]);
  }

  const { exitCode, stdout } = await runTasks(["summary", "--json", "--recent", "3"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const recent = parsed.recent as Array<Record<string, unknown>>;
  expect(recent).toHaveLength(3);
});

test("tasks summary --json --recent 0 rejects with INVALID_ARG", async () => {
  await runTasks(["init"]);

  const { exitCode, stderr } = await runTasks(["summary", "--json", "--recent", "0"]);
  expect(exitCode).not.toBe(0);

  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("INVALID_ARG");
});

test("tasks summary --json --recent -5 rejects with INVALID_ARG", async () => {
  await runTasks(["init"]);

  const { exitCode, stderr } = await runTasks(["summary", "--json", "--recent", "-5"]);
  expect(exitCode).not.toBe(0);

  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("INVALID_ARG");
});

test("tasks summary --json --recent abc rejects with INVALID_ARG", async () => {
  await runTasks(["init"]);

  const { exitCode, stderr } = await runTasks(["summary", "--json", "--recent", "abc"]);
  expect(exitCode).not.toBe(0);

  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("INVALID_ARG");
});

// ─── Slice 5: stale tasks in doing/blocked/review older than 14 days ─────────

test("tasks summary --json stale includes doing/blocked/review tasks older than 14 days, sorted oldest first", async () => {
  // Use --stale 0d to make all tasks stale immediately (threshold = 0 days).
  await runTasks(["new", "backlog-task"]);   // backlog, should NOT appear in stale
  await runTasks(["new", "doing-task"]);
  await runTasks(["new", "blocked-task"]);
  await runTasks(["new", "review-task"]);
  await runTasks(["new", "done-task"]);      // done, should NOT appear in stale
  await runTasks(["new", "ready-task"]);     // ready, should NOT appear in stale

  await runTasks(["mv", "2", "doing"]);
  await runTasks(["mv", "3", "blocked"]);
  await runTasks(["mv", "4", "review"]);
  await runTasks(["mv", "5", "done"]);

  // With --stale 0d all doing/blocked/review tasks count as stale.
  const { exitCode, stdout } = await runTasks(["summary", "--json", "--stale", "0d"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const stale = parsed.stale as Array<Record<string, unknown>>;

  // Only doing, blocked, review appear.
  const staleIds = stale.map((t) => t.id as number);
  expect(staleIds).toContain(2); // doing
  expect(staleIds).toContain(3); // blocked
  expect(staleIds).toContain(4); // review
  expect(staleIds).not.toContain(1); // backlog excluded
  expect(staleIds).not.toContain(5); // done excluded
  expect(staleIds).not.toContain(6); // ready excluded

  // Sorted oldest first (ascending updated_at).
  for (let i = 0; i < stale.length - 1; i++) {
    const a = new Date(stale[i].updated_at as string).getTime();
    const b = new Date(stale[i + 1].updated_at as string).getTime();
    expect(a).toBeLessThanOrEqual(b);
  }

  // Stale entries are minimal stubs (same shape as recent).
  for (const stub of stale) {
    expect(typeof stub.id).toBe("number");
    expect(typeof stub.uuid).toBe("string");
    expect(typeof stub.title).toBe("string");
    expect(typeof stub.column).toBe("string");
    expect(typeof stub.updated_at).toBe("string");
    expect(stub.body).toBeUndefined();
    expect(stub.deps).toBeUndefined();
  }
});

test("tasks summary --json stale is empty by default (tasks are freshly created, not 14+ days old)", async () => {
  await runTasks(["new", "doing-task"]);
  await runTasks(["mv", "1", "doing"]);

  // Default threshold is 14 days; freshly created tasks should not be stale.
  const { exitCode, stdout } = await runTasks(["summary", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const stale = parsed.stale as Array<Record<string, unknown>>;
  expect(stale).toHaveLength(0);
});

// ─── Slice 6: --stale <duration> flag ────────────────────────────────────────

test("tasks summary --json --stale 0d makes all doing/blocked/review tasks stale", async () => {
  await runTasks(["new", "doing-task"]);
  await runTasks(["mv", "1", "doing"]);

  const { exitCode, stdout } = await runTasks(["summary", "--json", "--stale", "0d"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const stale = parsed.stale as Array<Record<string, unknown>>;
  expect(stale).toHaveLength(1);
  expect((stale[0] as Record<string, unknown>).id).toBe(1);
});

test("tasks summary --json --stale with bad duration rejects with INVALID_ARG", async () => {
  await runTasks(["init"]);

  const { exitCode, stderr } = await runTasks(["summary", "--json", "--stale", "2weeks"]);
  expect(exitCode).not.toBe(0);

  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("INVALID_ARG");
});

test("tasks summary --json --stale with bad duration 'xyz' rejects with INVALID_ARG", async () => {
  await runTasks(["init"]);

  const { exitCode, stderr } = await runTasks(["summary", "--json", "--stale", "xyz"]);
  expect(exitCode).not.toBe(0);

  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("INVALID_ARG");
});

// ─── Slice 7: error path — running outside a store ───────────────────────────

test("tasks summary --json on uninitialized store exits non-zero with NOT_INITIALIZED and does NOT create the store", async () => {
  const { exitCode, stderr } = await runTasks(["summary", "--json"]);
  expect(exitCode).not.toBe(0);

  // Must not have auto-initialized.
  const projectsDir = join(tasksHome, "projects");
  expect(existsSync(projectsDir)).toBe(false);

  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("NOT_INITIALIZED");
});
