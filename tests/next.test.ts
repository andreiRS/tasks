import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-next-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-next-cwd-"));
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
    env: { ...process.env, TASKS_HOME: tasksHome } as Record<string, string>,
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

function getStoreDir(): string {
  const real = realpathSync(cwdDir);
  const encoded = real.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

async function plantTask(title: string): Promise<{ id: number; uuid: string }> {
  const { exitCode, stdout, stderr } = await runTasks(["new", title]);
  if (exitCode !== 0) throw new Error(`plantTask failed: ${stderr}`);
  const m = /new #(\d+)/.exec(stdout);
  if (!m) throw new Error(`plantTask: bad stdout "${stdout}"`);
  const id = parseInt(m[1], 10);
  const showRes = await runTasks(["show", String(id), "--json"]);
  const parsed = JSON.parse(showRes.stdout) as Record<string, unknown>;
  return { id, uuid: parsed.uuid as string };
}

// ─── 1. No store yet: NO_READY_TASK ──────────────────────────────────────────

test("tasks next with no store exits non-zero with NO_READY_TASK (--json)", async () => {
  const { exitCode, stderr } = await runTasks(["next", "--json"]);

  expect(exitCode).not.toBe(0);

  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  expect(parsed).toHaveProperty("error");
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("NO_READY_TASK");
  expect(typeof err.message).toBe("string");

  // Must NOT have initialized the store
  expect(existsSync(join(tasksHome, "projects"))).toBe(false);
});

test("tasks next with no store exits non-zero with plain-text NO_READY_TASK", async () => {
  const { exitCode, stderr } = await runTasks(["next"]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("NO_READY_TASK");
  // Must not be JSON
  expect(() => JSON.parse(stderr)).toThrow();
});

// ─── 2. Empty store (tasks exist but none in ready/) ─────────────────────────

test("tasks next with no tasks in ready/ exits non-zero with NO_READY_TASK", async () => {
  await plantTask("backlog task");
  // task is in backlog/, not ready/

  const { exitCode, stderr } = await runTasks(["next", "--json"]);

  expect(exitCode).not.toBe(0);
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("NO_READY_TASK");
});

// ─── 3. Single ready task with no deps: surfaces it ─────────────────────────

test("tasks next returns the single ready task with all deps done (no deps)", async () => {
  const { id } = await plantTask("a ready task");
  await runTasks(["mv", String(id), "ready"]);

  const { exitCode, stdout } = await runTasks(["next", "--json"]);

  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(parsed.id).toBe(id);
  expect(parsed.column).toBe("ready");
  expect(typeof parsed.uuid).toBe("string");
  expect(typeof parsed.title).toBe("string");
});

// ─── 4. Ready task whose dep is still in doing/ is blocked ───────────────────

test("tasks next skips ready task whose dep is NOT in done/", async () => {
  const dep = await plantTask("the blocker");
  const subject = await plantTask("the candidate");

  // Move subject to ready
  await runTasks(["mv", String(subject.id), "ready"]);
  // Move dep to doing (NOT done) -- blocker not resolved; NOT in ready so
  // dep itself does not count as a candidate either
  await runTasks(["mv", String(dep.id), "doing"]);

  // Link: subject depends on dep
  await runTasks(["link", String(subject.id), "--depends-on", String(dep.id)]);

  // subject is in ready but its dep is in doing, not done -- blocked
  const { exitCode, stderr } = await runTasks(["next", "--json"]);

  expect(exitCode).not.toBe(0);
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("NO_READY_TASK");
});

// ─── 5. Ready task whose dep is in review/ is still blocked ─────────────────

test("tasks next does NOT count review/ as done for blocking purposes", async () => {
  const dep = await plantTask("the blocker in review");
  const subject = await plantTask("the candidate");

  await runTasks(["mv", String(subject.id), "ready"]);
  await runTasks(["mv", String(dep.id), "review"]);
  await runTasks(["link", String(subject.id), "--depends-on", String(dep.id)]);

  const { exitCode, stderr } = await runTasks(["next", "--json"]);

  expect(exitCode).not.toBe(0);
  const err = (JSON.parse(stderr) as Record<string, unknown>).error as Record<string, unknown>;
  expect(err.code).toBe("NO_READY_TASK");
});

// ─── 6. Ready task whose dep is in done/ is unblocked ────────────────────────

test("tasks next surfaces ready task whose dep is in done/", async () => {
  const dep = await plantTask("the finished blocker");
  const subject = await plantTask("the candidate");

  await runTasks(["mv", String(subject.id), "ready"]);
  await runTasks(["mv", String(dep.id), "done"]);
  await runTasks(["link", String(subject.id), "--depends-on", String(dep.id)]);

  const { exitCode, stdout } = await runTasks(["next", "--json"]);

  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(parsed.id).toBe(subject.id);
});

// ─── 7. Oldest created_at wins among multiple candidates ─────────────────────

test("tasks next returns the task with the oldest created_at when multiple are ready and unblocked", async () => {
  const t1 = await plantTask("older task");
  const t2 = await plantTask("newer task");

  await runTasks(["mv", String(t1.id), "ready"]);
  await runTasks(["mv", String(t2.id), "ready"]);

  const { exitCode, stdout } = await runTasks(["next", "--json"]);

  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  // t1 was created first (lower id, earlier timestamp)
  expect(parsed.id).toBe(t1.id);
});

// ─── 8. --unattended restricts to unattended tasks ────────────────────────────

test("tasks next --unattended returns only unattended tasks from ready/", async () => {
  const attended = await plantTask("attended task");
  const unattended_task = await plantTask("unattended task");

  await runTasks(["mv", String(attended.id), "ready"]);
  await runTasks(["mv", String(unattended_task.id), "ready"]);
  await runTasks(["set", String(unattended_task.id), "--attendance", "unattended"]);

  const { exitCode, stdout } = await runTasks(["next", "--unattended", "--json"]);

  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(parsed.id).toBe(unattended_task.id);
  expect(parsed.attendance).toBe("unattended");
});

test("tasks next --unattended with no unattended task in ready/ exits non-zero with NO_READY_TASK", async () => {
  const t = await plantTask("attended only");
  await runTasks(["mv", String(t.id), "ready"]);
  // leave as attended (default)

  const { exitCode, stderr } = await runTasks(["next", "--unattended", "--json"]);

  expect(exitCode).not.toBe(0);
  const err = (JSON.parse(stderr) as Record<string, unknown>).error as Record<string, unknown>;
  expect(err.code).toBe("NO_READY_TASK");
});

// ─── 9. --attendance <value> is the long form of --unattended ─────────────────

test("tasks next --attendance unattended behaves the same as --unattended", async () => {
  const t = await plantTask("unattended candidate");
  await runTasks(["mv", String(t.id), "ready"]);
  await runTasks(["set", String(t.id), "--attendance", "unattended"]);

  const { exitCode, stdout } = await runTasks(["next", "--attendance", "unattended", "--json"]);

  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(parsed.id).toBe(t.id);
});

// ─── 10. Invalid --attendance value: INVALID_ATTENDANCE ──────────────────────

test("tasks next --attendance bogus exits non-zero with INVALID_ATTENDANCE", async () => {
  const { exitCode, stderr } = await runTasks(["next", "--attendance", "bogus", "--json"]);

  expect(exitCode).not.toBe(0);
  const err = (JSON.parse(stderr) as Record<string, unknown>).error as Record<string, unknown>;
  expect(err.code).toBe("INVALID_ATTENDANCE");
});

// ─── 11. Conflict: --attendance attended AND --unattended errors ──────────────

test("tasks next --attendance attended --unattended exits non-zero with a conflict error", async () => {
  const { exitCode, stderr } = await runTasks([
    "next",
    "--attendance",
    "attended",
    "--unattended",
    "--json",
  ]);

  expect(exitCode).not.toBe(0);
  // Should have some error on stderr
  expect(stderr.length).toBeGreaterThan(0);
  // Error JSON must be parseable
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const err = parsed.error as Record<string, unknown>;
  expect(typeof err.code).toBe("string");
  expect(typeof err.message).toBe("string");
});

// ─── 12. Human rendering (no --json): a task block is printed ────────────────

test("tasks next without --json prints human-readable task output on stdout", async () => {
  const { id } = await plantTask("readable task");
  await runTasks(["mv", String(id), "ready"]);

  const { exitCode, stdout } = await runTasks(["next"]);

  expect(exitCode).toBe(0);
  // Should contain the task id and title
  expect(stdout).toContain(`#${id}`);
  expect(stdout).toContain("readable task");
});

// ─── 13. --json shape matches tasks show --json ───────────────────────────────

test("tasks next --json output has the same shape as tasks show --json for the same task", async () => {
  const { id } = await plantTask("shape test task");
  await runTasks(["mv", String(id), "ready"]);

  const nextRes = await runTasks(["next", "--json"]);
  expect(nextRes.exitCode).toBe(0);
  const nextParsed = JSON.parse(nextRes.stdout) as Record<string, unknown>;

  const showRes = await runTasks(["show", String(id), "--json"]);
  expect(showRes.exitCode).toBe(0);
  const showParsed = JSON.parse(showRes.stdout) as Record<string, unknown>;

  // Core fields must match
  expect(nextParsed.id).toBe(showParsed.id);
  expect(nextParsed.uuid).toBe(showParsed.uuid);
  expect(nextParsed.title).toBe(showParsed.title);
  expect(nextParsed.column).toBe(showParsed.column);
  expect(nextParsed.attendance).toBe(showParsed.attendance);
  expect(nextParsed.effort).toBe(showParsed.effort);
});

// ─── 14. Read-only: does NOT auto-init when store is absent ──────────────────

test("tasks next does not create the store directory when no store exists", async () => {
  const { exitCode } = await runTasks(["next"]);

  expect(exitCode).not.toBe(0);
  expect(existsSync(join(tasksHome, "projects"))).toBe(false);
});
