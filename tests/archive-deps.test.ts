import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-archive-deps-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-archive-deps-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

async function runTasks(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

function deriveStoreDir(): string {
  const realCwd = realpathSync(cwdDir);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

async function newId(title: string): Promise<number> {
  const r = await runTasks(["new", title]);
  if (r.exitCode !== 0) throw new Error(`new failed: ${r.stderr}`);
  return parseInt(r.stdout.match(/#(\d+)/)![1], 10);
}

test("tasks next: archived dep counts as Complete and unblocks ready task", async () => {
  const blockerId = await newId("the blocker");
  // Move blocker to done so we can archive it.
  await runTasks(["mv", String(blockerId), "done"]);

  const dependentId = await newId("dependent");
  // Link the dependent to the blocker via its uuid (use short id since CLI accepts both).
  await runTasks(["link", String(dependentId), "--depends-on", String(blockerId)]);
  await runTasks(["mv", String(dependentId), "ready"]);

  // Sanity: before archive, `next` returns the ready task because its dep is in done.
  const beforeArchive = await runTasks(["next"]);
  expect(beforeArchive.exitCode).toBe(0);

  // Archive the blocker.
  const arch = await runTasks(["archive", String(blockerId)]);
  expect(arch.exitCode).toBe(0);

  // After archive, `next` must still surface the dependent (archived ≡ complete).
  const afterArchive = await runTasks(["next"]);
  expect(afterArchive.exitCode).toBe(0);
  expect(afterArchive.stdout).toContain(`#${dependentId}`);
});

test("tasks show: renders an archived dep as #id title (not <unknown>)", async () => {
  const blockerId = await newId("first blocker");
  await runTasks(["mv", String(blockerId), "done"]);

  const dependentId = await newId("waits on first");
  await runTasks(["link", String(dependentId), "--depends-on", String(blockerId)]);

  await runTasks(["archive", String(blockerId)]);

  const show = await runTasks(["show", String(dependentId)]);
  expect(show.exitCode).toBe(0);
  expect(show.stdout).toContain(`#${blockerId} first blocker`);
  expect(show.stdout).not.toContain("<unknown>");
});

test("tasks archive: archiving a still-depended-on done task succeeds and preserves the edge", async () => {
  // Decision: archive has no DEP_EXISTS guard (unlike rm). A live task may
  // legitimately depend on archived (= Complete) work, so archiving a target
  // that something still depends on must just work and keep the edge intact.
  const blockerId = await newId("the done blocker");
  await runTasks(["mv", String(blockerId), "done"]);
  const dependentId = await newId("still waiting");
  await runTasks(["link", String(dependentId), "--depends-on", String(blockerId)]);

  const arch = await runTasks(["archive", String(blockerId)]);
  expect(arch.exitCode).toBe(0);
  expect(arch.stderr).toBe("");

  // The edge is preserved (not stripped) and still resolves to the archived task.
  const show = await runTasks(["show", String(dependentId), "--json"]);
  const data = JSON.parse(show.stdout) as { deps: string[] };
  expect(data.deps.length).toBe(1);

  // The archived dep counts as Complete, so the dependent is not blocked.
  const list = await runTasks(["list", "--json"]);
  const row = (JSON.parse(list.stdout) as { id: number; blockedBy: number[] }[])
    .find((r) => r.id === dependentId);
  expect(row?.blockedBy).toEqual([]);

  // And the graph stays mutable afterwards.
  const setOk = await runTasks(["set", String(dependentId), "--effort", "high"]);
  expect(setOk.exitCode).toBe(0);
});

test("tasks link: a new edge succeeds even when the subject already depends on an archived task", async () => {
  // Repro of the validator catch-22: link D -> B (B in done), archive B, then
  // any later graph mutation rebuilt the DAG from LIVE tasks only and threw
  // UNKNOWN_UUID on D's now-archived dep. The validator must count archived
  // tasks as resolvable (terminal) nodes.
  const blockerId = await newId("blocker");
  await runTasks(["mv", String(blockerId), "done"]);
  const dependentId = await newId("dependent");
  await runTasks(["link", String(dependentId), "--depends-on", String(blockerId)]);
  await runTasks(["archive", String(blockerId)]);

  // A brand-new, unrelated edge on the dependent must not be blocked by the
  // pre-existing archived dep.
  const otherId = await newId("other");
  const link = await runTasks(["link", String(dependentId), "--depends-on", String(otherId)]);
  expect(link.stderr).toBe("");
  expect(link.exitCode).toBe(0);
});

test("tasks new --deps: can depend on an archived task", async () => {
  const blockerId = await newId("archived blocker");
  await runTasks(["mv", String(blockerId), "done"]);
  await runTasks(["archive", String(blockerId)]);

  const create = await runTasks(["new", "depends on archived", "--deps", String(blockerId)]);
  expect(create.stderr).toBe("");
  expect(create.exitCode).toBe(0);
});

test("tasks list: an archived blocker does NOT produce a [blocked by] marker", async () => {
  const blockerId = await newId("blocker");
  await runTasks(["mv", String(blockerId), "done"]);
  const dependentId = await newId("dependent");
  await runTasks(["link", String(dependentId), "--depends-on", String(blockerId)]);
  await runTasks(["mv", String(dependentId), "ready"]);
  await runTasks(["archive", String(blockerId)]);

  const list = await runTasks(["list", "--json"]);
  expect(list.exitCode).toBe(0);
  const rows = JSON.parse(list.stdout);
  const row = rows.find((r: { id: number }) => r.id === dependentId);
  expect(row).toBeDefined();
  expect(row.blockedBy).toEqual([]);

  // Confirm the text marker is also absent.
  const human = await runTasks(["list"]);
  expect(human.exitCode).toBe(0);
  expect(human.stdout).not.toContain(`[blocked by #${blockerId}]`);

  void deriveStoreDir(); void readdirSync;
});
