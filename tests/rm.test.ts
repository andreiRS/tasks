import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-rm-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-rm-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

/** Run a tasks CLI command and return {exitCode, stdout, stderr}. */
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

/** Plant a task, return its short id. */
async function plantTask(title: string = "a task"): Promise<number> {
  const { exitCode, stderr, stdout } = await runTasks(["new", title]);
  if (exitCode !== 0) throw new Error(`plantTask failed: ${stderr}`);
  const match = /new #(\d+)/.exec(stdout);
  if (!match) throw new Error(`plantTask: unexpected stdout: ${stdout}`);
  return parseInt(match[1], 10);
}

/** Get the git log count (number of commits) in the store. */
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

/** Return the store dir path for this test's tasksHome + cwdDir. */
function deriveStoreDir(): string {
  const realCwd = realpathSync(cwdDir);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

/** Find all .md files in a column dir. */
function filesInColumn(storeDir: string, col: string): string[] {
  const colDir = join(storeDir, col);
  if (!existsSync(colDir)) return [];
  return readdirSync(colDir).filter((f) => f.endsWith(".md"));
}

// ─── Test 1: happy path by short id ──────────────────────────────────────────

test("tasks rm by id: file gone, single new commit, exit 0", async () => {
  const id = await plantTask("delete me");
  const storeDir = deriveStoreDir();

  // File must exist before rm
  expect(filesInColumn(storeDir, "backlog").length).toBe(1);

  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode } = await runTasks(["rm", String(id)]);
  expect(exitCode).toBe(0);

  // File must be gone from all columns
  for (const col of ["backlog", "ready", "doing", "blocked", "review", "done"]) {
    expect(filesInColumn(storeDir, col).length).toBe(0);
  }

  // Exactly one new commit
  expect(await gitLogCount(storeDir)).toBe(commitsBefore + 1);
});

// ─── Test 2: happy path by uuid ───────────────────────────────────────────────

test("tasks rm by uuid: file gone, single new commit, exit 0", async () => {
  const id = await plantTask("delete by uuid");
  const storeDir = deriveStoreDir();

  // Get the UUID via show --json
  const { stdout } = await runTasks(["show", String(id), "--json"]);
  const task = JSON.parse(stdout) as Record<string, unknown>;
  const uuid = task.uuid as string;

  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode } = await runTasks(["rm", uuid]);
  expect(exitCode).toBe(0);

  expect(filesInColumn(storeDir, "backlog").length).toBe(0);
  expect(await gitLogCount(storeDir)).toBe(commitsBefore + 1);
});

// ─── Test 3: not found (plain text) ──────────────────────────────────────────

test("tasks rm with unknown id prints NOT_FOUND on stderr, exits non-zero", async () => {
  await plantTask("some task");

  const { exitCode, stderr } = await runTasks(["rm", "999"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("NOT_FOUND");
  expect(() => JSON.parse(stderr)).toThrow();
});

// ─── Test 4: not found with --json ───────────────────────────────────────────

test("tasks rm with unknown id and --json emits JSON envelope NOT_FOUND", async () => {
  await plantTask("some task");

  const { exitCode, stderr } = await runTasks(["rm", "999", "--json"]);
  expect(exitCode).not.toBe(0);
  let parsed: Record<string, unknown>;
  expect(() => { parsed = JSON.parse(stderr); }).not.toThrow();
  parsed = JSON.parse(stderr);
  expect((parsed.error as Record<string, unknown>).code).toBe("NOT_FOUND");
});

// ─── Test 5: dirty-tree guard ─────────────────────────────────────────────────

test("tasks rm refuses with STORE_DIRTY when the working tree has uncommitted changes", async () => {
  await plantTask("dirty task");

  const storeDir = deriveStoreDir();

  // Plant a dirty file in the store
  writeFileSync(join(storeDir, "dirty.txt"), "mess\n", "utf-8");
  const gitBin = Bun.which("git") ?? "/opt/homebrew/bin/git";
  const addProc = Bun.spawn([gitBin, "add", "dirty.txt"], { cwd: storeDir, stdout: "pipe", stderr: "pipe" });
  await addProc.exited;

  const { exitCode, stderr } = await runTasks(["rm", "1"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("STORE_DIRTY");
});

// ─── Test 6: after rm, show returns NOT_FOUND ────────────────────────────────

test("after tasks rm, tasks show returns NOT_FOUND", async () => {
  const id = await plantTask("transient task");

  const { exitCode: rmExit } = await runTasks(["rm", String(id)]);
  expect(rmExit).toBe(0);

  const { exitCode: showExit, stderr } = await runTasks(["show", String(id), "--json"]);
  expect(showExit).not.toBe(0);
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  expect((parsed.error as Record<string, unknown>).code).toBe("NOT_FOUND");
});
