import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-unlink-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-unlink-cwd-"));
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

async function plantTask(title: string): Promise<{ id: number; uuid: string }> {
  const { exitCode, stdout, stderr } = await runTasks(["new", title]);
  if (exitCode !== 0) throw new Error(`plantTask failed: ${stderr}`);
  const m = /new #(\d+)/.exec(stdout);
  if (!m) throw new Error(`plantTask: bad stdout "${stdout}"`);
  const id = parseInt(m[1], 10);
  const { stdout: showOut } = await runTasks(["show", String(id), "--json"]);
  const parsed = JSON.parse(showOut) as { uuid: string };
  return { id, uuid: parsed.uuid };
}

async function getTaskDeps(idOrUuid: string): Promise<string[]> {
  const { stdout } = await runTasks(["show", idOrUuid, "--json"]);
  const parsed = JSON.parse(stdout) as { deps: string[] };
  return parsed.deps;
}

async function gitLogCount(storeDir: string): Promise<number> {
  const gitBin = Bun.which("git") ?? "/opt/homebrew/bin/git";
  const proc = Bun.spawn([gitBin, "log", "--oneline"], {
    cwd: storeDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const out = await new Response(proc.stdout).text();
  return out.trim() === "" ? 0 : out.trim().split("\n").length;
}

function deriveStoreDir(): string {
  const realCwd = realpathSync(cwdDir);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

// Helper: link A -> B (A depends on B)
async function linkTasks(subjectId: number, targetUuid: string): Promise<void> {
  const { exitCode, stderr } = await runTasks(["link", String(subjectId), "--depends-on", targetUuid]);
  if (exitCode !== 0) throw new Error(`linkTasks failed: ${stderr}`);
}

// ─── Test 1: happy path ───────────────────────────────────────────────────────

test("tasks unlink A --depends-on B: removes B from A's deps, exit 0, one commit added", async () => {
  const taskA = await plantTask("task A");
  const taskB = await plantTask("task B");
  const taskC = await plantTask("task C");
  await linkTasks(taskA.id, taskB.uuid);
  await linkTasks(taskA.id, taskC.uuid);

  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["unlink", String(taskA.id), "--depends-on", taskB.uuid]);
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("error");

  const deps = await getTaskDeps(String(taskA.id));
  expect(deps).not.toContain(taskB.uuid);
  expect(deps).toContain(taskC.uuid);

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore + 1);
});

// ─── Test 2: multiple targets in one invocation ───────────────────────────────

test("tasks unlink A --depends-on B --depends-on C: removes both, leaves D, ONE new commit", async () => {
  const taskA = await plantTask("task A");
  const taskB = await plantTask("task B");
  const taskC = await plantTask("task C");
  const taskD = await plantTask("task D");
  await linkTasks(taskA.id, taskB.uuid);
  await linkTasks(taskA.id, taskC.uuid);
  await linkTasks(taskA.id, taskD.uuid);

  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode } = await runTasks([
    "unlink", String(taskA.id),
    "--depends-on", taskB.uuid,
    "--depends-on", taskC.uuid,
  ]);
  expect(exitCode).toBe(0);

  const deps = await getTaskDeps(String(taskA.id));
  expect(deps).not.toContain(taskB.uuid);
  expect(deps).not.toContain(taskC.uuid);
  expect(deps).toContain(taskD.uuid);

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore + 1);
});

// ─── Test 3: idempotent - absent target is a real task but not in deps ────────

test("tasks unlink A --depends-on C when C is real but not a dep: exit 0, no commit", async () => {
  const taskA = await plantTask("task A");
  const taskB = await plantTask("task B");
  const taskC = await plantTask("task C");
  await linkTasks(taskA.id, taskB.uuid);

  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode } = await runTasks(["unlink", String(taskA.id), "--depends-on", taskC.uuid]);
  expect(exitCode).toBe(0);

  const deps = await getTaskDeps(String(taskA.id));
  expect(deps).toContain(taskB.uuid);

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore); // no commit made
});

// ─── Test 4: all targets absent - no-op, no commit ───────────────────────────

test("tasks unlink A with all targets already absent: exit 0, no commit, deps unchanged", async () => {
  const taskA = await plantTask("task A");
  const taskB = await plantTask("task B");
  const taskC = await plantTask("task C");
  // A has no deps at all; B and C are real tasks but not in A's deps

  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode } = await runTasks([
    "unlink", String(taskA.id),
    "--depends-on", taskB.uuid,
    "--depends-on", taskC.uuid,
  ]);
  expect(exitCode).toBe(0);

  const deps = await getTaskDeps(String(taskA.id));
  expect(deps).toEqual([]);

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore); // no commit made
});

// ─── Test 5: unknown uuid target ─────────────────────────────────────────────

test("tasks unlink A --depends-on <bogus-uuid> exits non-zero with UNKNOWN_UUID", async () => {
  const taskA = await plantTask("task A");
  const bogus = "00000000-0000-4000-8000-000000000000";

  const { exitCode, stderr } = await runTasks(["unlink", String(taskA.id), "--depends-on", bogus]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("UNKNOWN_UUID");
});

// ─── Test 6: self-unlink is rejected with SELF_LINK ──────────────────────────

test("tasks unlink A --depends-on A exits non-zero with SELF_LINK", async () => {
  const taskA = await plantTask("task A");

  const { exitCode, stderr } = await runTasks(["unlink", String(taskA.id), "--depends-on", taskA.uuid]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("SELF_LINK");
});
