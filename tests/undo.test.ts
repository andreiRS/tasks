import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-undo-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-undo-cwd-"));
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

function listMd(storeDir: string, col: string): string[] {
  const colDir = join(storeDir, col);
  if (!existsSync(colDir)) return [];
  return readdirSync(colDir).filter((f) => f.endsWith(".md"));
}

test("undo reverts a tasks new and the revert is a new commit", async () => {
  const created = await runTasks(["new", "first task"]);
  expect(created.exitCode).toBe(0);

  const storeDir = deriveStoreDir();
  const beforeCount = await gitLogCount(storeDir);
  expect(listMd(storeDir, "backlog").length).toBe(1);

  const undo = await runTasks(["undo"]);
  expect(undo.exitCode).toBe(0);

  expect(listMd(storeDir, "backlog").length).toBe(0);

  const afterCount = await gitLogCount(storeDir);
  expect(afterCount).toBe(beforeCount + 1);
});

test("undo reverts a tasks mv, returning the task to the prior column", async () => {
  const created = await runTasks(["new", "movable"]);
  expect(created.exitCode).toBe(0);
  const moved = await runTasks(["mv", "1", "ready"]);
  expect(moved.exitCode).toBe(0);

  const storeDir = deriveStoreDir();
  expect(listMd(storeDir, "ready").length).toBe(1);
  expect(listMd(storeDir, "backlog").length).toBe(0);

  const undo = await runTasks(["undo"]);
  expect(undo.exitCode).toBe(0);

  expect(listMd(storeDir, "backlog").length).toBe(1);
  expect(listMd(storeDir, "ready").length).toBe(0);
});

test("undo is itself undoable (re-undo restores the task)", async () => {
  const created = await runTasks(["new", "reappearing"]);
  expect(created.exitCode).toBe(0);

  const storeDir = deriveStoreDir();
  expect(listMd(storeDir, "backlog").length).toBe(1);

  const u1 = await runTasks(["undo"]);
  expect(u1.exitCode).toBe(0);
  expect(listMd(storeDir, "backlog").length).toBe(0);

  const u2 = await runTasks(["undo"]);
  expect(u2.exitCode).toBe(0);
  expect(listMd(storeDir, "backlog").length).toBe(1);
});

test("undo refuses on a fresh auto-inited store with NOTHING_TO_UNDO", async () => {
  const result = await runTasks(["undo", "--json"]);
  expect(result.exitCode).not.toBe(0);
  const payload = JSON.parse(result.stderr.trim().split("\n").pop()!);
  expect(payload.error.code).toBe("NOTHING_TO_UNDO");
});

test("undo --json emits a success envelope after a tasks new", async () => {
  const created = await runTasks(["new", "json target"]);
  expect(created.exitCode).toBe(0);

  const undo = await runTasks(["undo", "--json"]);
  expect(undo.exitCode).toBe(0);
  // Success: structured JSON on stdout, parseable. Match the minimal shape
  // used by other mutating commands when they emit success JSON.
  const out = undo.stdout.trim();
  expect(out.length).toBeGreaterThan(0);
  const parsed = JSON.parse(out);
  expect(parsed).toBeTruthy();
});
