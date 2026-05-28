import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let tasksHome: string;
let cwdDir: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-init-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-init-cwd-"));
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

async function runCli(args: string[], cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwd ?? cwdDir,
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

function getStoreDir(): string {
  // The store is under tasksHome/projects/<encoded-cwd>
  const projectsDir = join(tasksHome, "projects");
  if (!existsSync(projectsDir)) return "";
  const entries = require("node:fs").readdirSync(projectsDir);
  if (entries.length === 0) return "";
  return join(projectsDir, entries[0]);
}

// ---- Test 1: first init creates the store ----
test("tasks init: first init creates store with all six column dirs and meta.yaml at next_id 1", async () => {
  const { exitCode, stderr } = await runCli(["init"]);

  expect(exitCode).toBe(0);
  expect(stderr).toContain("initialized store at");

  const dir = getStoreDir();
  expect(dir).not.toBe("");
  expect(existsSync(join(dir, ".git"))).toBe(true);

  for (const col of ["backlog", "ready", "doing", "blocked", "review", "done"]) {
    expect(existsSync(join(dir, col))).toBe(true);
  }

  expect(existsSync(join(dir, "meta.yaml"))).toBe(true);
  const meta = readFileSync(join(dir, "meta.yaml"), "utf-8");
  expect(meta.trim()).toBe("next_id: 1");

  // Verify exactly one commit (the seed commit)
  const logProc = Bun.spawn(["git", "log", "--oneline"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await logProc.exited;
  const log = await new Response(logProc.stdout).text();
  const commitLines = log.trim().split("\n").filter(Boolean);
  expect(commitLines.length).toBe(1);
  expect(commitLines[0]).toContain("init");
});

// ---- Test 2: idempotent re-init ----
test("tasks init: second run exits 0 with already-exists message and does not re-commit", async () => {
  // First init
  const first = await runCli(["init"]);
  expect(first.exitCode).toBe(0);

  const dir = getStoreDir();
  expect(dir).not.toBe("");

  // Count commits after first init
  const logBefore = Bun.spawn(["git", "log", "--oneline"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await logBefore.exited;
  const logBeforeText = await new Response(logBefore.stdout).text();
  const commitsBefore = logBeforeText.trim().split("\n").filter(Boolean).length;

  // Second init
  const second = await runCli(["init"]);
  expect(second.exitCode).toBe(0);
  expect(second.stderr).toContain("already exists");

  // Commit count must not have grown
  const logAfter = Bun.spawn(["git", "log", "--oneline"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await logAfter.exited;
  const logAfterText = await new Response(logAfter.stdout).text();
  const commitsAfter = logAfterText.trim().split("\n").filter(Boolean).length;

  expect(commitsAfter).toBe(commitsBefore);
  expect(commitsAfter).toBe(1);
});

// ---- Test 3: --json first init ----
test("tasks init --json: first init emits { ok: true, created: true, path: <dir> }", async () => {
  const { exitCode, stdout, stderr } = await runCli(["init", "--json"]);

  expect(exitCode).toBe(0);

  let envelope: Record<string, unknown>;
  expect(() => { envelope = JSON.parse(stdout); }).not.toThrow();
  envelope = JSON.parse(stdout);

  expect(envelope.ok).toBe(true);
  expect(envelope.created).toBe(true);
  expect(typeof envelope.path).toBe("string");
  expect((envelope.path as string).length).toBeGreaterThan(0);

  // stderr still gets the human init notice (initStore writes it)
  expect(stderr).toContain("initialized store at");
});

// ---- Test 4: --json idempotent ----
test("tasks init --json: second run emits { ok: true, created: false }", async () => {
  // First init (plain)
  await runCli(["init"]);

  // Second init with --json
  const { exitCode, stdout } = await runCli(["init", "--json"]);

  expect(exitCode).toBe(0);

  let envelope: Record<string, unknown>;
  expect(() => { envelope = JSON.parse(stdout); }).not.toThrow();
  envelope = JSON.parse(stdout);

  expect(envelope.ok).toBe(true);
  expect(envelope.created).toBe(false);
  expect(typeof envelope.path).toBe("string");
});

// ---- Test 5: functional equivalence - explicit init then tasks new works ----
test("tasks init: explicit init does not break tasks new (auto-init code path)", async () => {
  // Explicit init first
  const initResult = await runCli(["init"]);
  expect(initResult.exitCode).toBe(0);

  // tasks new should work
  const newResult = await runCli(["new", "hello world"]);
  expect(newResult.exitCode).toBe(0);
  expect(newResult.stdout).toContain("#1");
  expect(newResult.stdout).toContain("hello world");

  // Confirm the task file is present in backlog
  const dir = getStoreDir();
  const backlogFiles = require("node:fs").readdirSync(join(dir, "backlog")).filter((f: string) => f.endsWith(".md"));
  expect(backlogFiles.length).toBe(1);
  expect(backlogFiles[0]).toContain("hello-world");
});
