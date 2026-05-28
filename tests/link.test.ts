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
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-link-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-link-cwd-"));
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

// ─── Test 1: happy path ───────────────────────────────────────────────────────

test("tasks link A --depends-on B: A's deps contains B's UUID, exit 0, one commit added", async () => {
  const taskA = await plantTask("task A");
  const taskB = await plantTask("task B");
  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["link", String(taskA.id), "--depends-on", taskB.uuid]);
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("error");

  const deps = await getTaskDeps(String(taskA.id));
  expect(deps).toContain(taskB.uuid);

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore + 1);
});

// ─── Test 2: multiple targets in one invocation ───────────────────────────────

test("tasks link A --depends-on B --depends-on C: both UUIDs in deps, ONE new commit", async () => {
  const taskA = await plantTask("task A");
  const taskB = await plantTask("task B");
  const taskC = await plantTask("task C");
  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode } = await runTasks([
    "link", String(taskA.id),
    "--depends-on", taskB.uuid,
    "--depends-on", taskC.uuid,
  ]);
  expect(exitCode).toBe(0);

  const deps = await getTaskDeps(String(taskA.id));
  expect(deps).toContain(taskB.uuid);
  expect(deps).toContain(taskC.uuid);

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore + 1);
});

// ─── Test 3: idempotent (no duplicate entries) ────────────────────────────────

test("tasks link A to B twice leaves a single entry in deps", async () => {
  const taskA = await plantTask("task A");
  const taskB = await plantTask("task B");

  const { exitCode: e1 } = await runTasks(["link", String(taskA.id), "--depends-on", taskB.uuid]);
  expect(e1).toBe(0);

  const { exitCode: e2 } = await runTasks(["link", String(taskA.id), "--depends-on", taskB.uuid]);
  expect(e2).toBe(0);

  const deps = await getTaskDeps(String(taskA.id));
  const count = deps.filter((d) => d === taskB.uuid).length;
  expect(count).toBe(1);
});

// ─── Test 4: self-link rejected ───────────────────────────────────────────────

test("tasks link A --depends-on A exits non-zero with SELF_LINK error", async () => {
  const taskA = await plantTask("task A");

  const { exitCode, stderr } = await runTasks(["link", String(taskA.id), "--depends-on", taskA.uuid]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("SELF_LINK");
});

// ─── Test 5: cycle detection ──────────────────────────────────────────────────

test("tasks link B --depends-on A when A already depends on B: CYCLE_DETECTED, exit non-zero", async () => {
  const taskA = await plantTask("cyc A");
  const taskB = await plantTask("cyc B");

  // A depends on B (succeeds)
  const { exitCode: e1 } = await runTasks(["link", String(taskA.id), "--depends-on", taskB.uuid]);
  expect(e1).toBe(0);

  // B depends on A -> cycle
  const { exitCode: e2, stderr } = await runTasks(["link", String(taskB.id), "--depends-on", taskA.uuid]);
  expect(e2).not.toBe(0);
  expect(stderr).toContain("CYCLE_DETECTED");
});

// ─── Test 6: unknown target UUID ─────────────────────────────────────────────

test("tasks link A --depends-on <bogus-uuid> exits non-zero with UNKNOWN_UUID", async () => {
  const taskA = await plantTask("task A");
  const bogus = "00000000-0000-4000-8000-000000000000";

  const { exitCode, stderr } = await runTasks(["link", String(taskA.id), "--depends-on", bogus]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("UNKNOWN_UUID");
});

// ─── Test 7: short numeric IDs work for subject ───────────────────────────────

test("tasks link accepts short numeric id for subject", async () => {
  const taskA = await plantTask("numeric A");
  const taskB = await plantTask("numeric B");

  const { exitCode } = await runTasks(["link", String(taskA.id), "--depends-on", taskB.uuid]);
  expect(exitCode).toBe(0);

  const deps = await getTaskDeps(String(taskA.id));
  expect(deps).toContain(taskB.uuid);
});

// ─── Test 8: target by short numeric id ──────────────────────────────────────

test("tasks link resolves target by short numeric id", async () => {
  const taskA = await plantTask("ref A");
  const taskB = await plantTask("ref B");

  const { exitCode } = await runTasks(["link", String(taskA.id), "--depends-on", String(taskB.id)]);
  expect(exitCode).toBe(0);

  const deps = await getTaskDeps(String(taskA.id));
  expect(deps).toContain(taskB.uuid);
});
