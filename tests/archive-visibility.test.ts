import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-archive-vis-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-archive-vis-cwd-"));
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

async function newId(title: string): Promise<number> {
  const r = await runTasks(["new", title]);
  if (r.exitCode !== 0) throw new Error(`new failed: ${r.stderr}`);
  return parseInt(r.stdout.match(/#(\d+)/)![1], 10);
}

test("tasks list: archive/ tasks are hidden by default", async () => {
  const liveId = await newId("still around");
  const goneId = await newId("ancient");
  await runTasks(["mv", String(goneId), "done"]);
  await runTasks(["archive", String(goneId)]);

  const list = await runTasks(["list"]);
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toContain(`#${liveId}`);
  expect(list.stdout).not.toContain(`#${goneId}`);
});

test("tasks list --archived: shows only archived tasks", async () => {
  const liveId = await newId("still around");
  const goneId = await newId("ancient");
  await runTasks(["mv", String(goneId), "done"]);
  await runTasks(["archive", String(goneId)]);

  const list = await runTasks(["list", "--archived"]);
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toContain(`#${goneId}`);
  expect(list.stdout).not.toContain(`#${liveId}`);
});

test("tasks show <id>: resolves an archived task", async () => {
  const goneId = await newId("retired");
  await runTasks(["mv", String(goneId), "done"]);
  await runTasks(["archive", String(goneId)]);

  const show = await runTasks(["show", String(goneId)]);
  expect(show.exitCode).toBe(0);
  expect(show.stdout).toContain(`#${goneId} retired`);
  expect(show.stdout).toContain("archive");
});
