import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBoard } from "../src/render.ts";
import { COLUMNS } from "../src/store.ts";
import type { TaskData } from "../src/store.ts";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-board-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-board-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

async function runTasks(args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
 * Manually plant a task file into a given column directory.
 */
function plantTask(storeDir: string, column: string, id: number, title: string): void {
  const colDir = join(storeDir, column);
  mkdirSync(colDir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filename = `${id}-${slug}.md`;
  const now = "2026-05-27T10:00:00.000Z";
  const uuid = `${"a".repeat(8)}-${id.toString().padStart(4, "0")}-4000-8000-${"b".repeat(12)}`;
  const content = `---\nid: ${id}\nuuid: ${uuid}\ntitle: ${title}\ncreated_at: ${now}\nupdated_at: ${now}\n---\n`;
  writeFileSync(join(colDir, filename), content, "utf-8");
}

/**
 * Initialize a bare store without going through the CLI.
 */
async function initBareStore(storeDir: string): Promise<void> {
  mkdirSync(storeDir, { recursive: true });
  for (const col of COLUMNS) {
    mkdirSync(join(storeDir, col), { recursive: true });
  }
  const spawn = (args: string[]) =>
    Bun.spawn(args, { cwd: storeDir, stdout: "pipe", stderr: "pipe" }).exited;
  await spawn(["git", "init"]);
  writeFileSync(join(storeDir, ".gitignore"), ".tasks-lock\n", "utf-8");
  await spawn(["git", "add", ".gitignore"]);
  await spawn(["git", "commit", "-m", "init"]);
  writeFileSync(join(storeDir, "meta.yaml"), "next_id: 1\n", "utf-8");
  await spawn(["git", "add", "meta.yaml"]);
  await spawn(["git", "commit", "-m", "meta"]);
}

/**
 * Derive the store path from tasksHome + encoded cwd.
 */
function deriveStorePath(tasksHome: string, cwd: string): string {
  const realCwd = realpathSync(cwd);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

// ─── Unit tests for renderBoard ──────────────────────────────────────────────

function makeTask(id: number, column: string, title: string): TaskData {
  return {
    id,
    uuid: `${"a".repeat(8)}-${id.toString().padStart(4, "0")}-4000-8000-${"b".repeat(12)}`,
    title,
    column,
    created_at: "2026-05-27T10:00:00.000Z",
    updated_at: "2026-05-27T10:00:00.000Z",
    body: "",
    deps: [],
    agent_ready: false,
    human_in_loop: false,
  };
}

test("renderBoard: all six column headers appear in output", () => {
  const grouped: Record<string, TaskData[]> = {
    backlog: [makeTask(1, "backlog", "alpha")],
    ready: [],
    doing: [makeTask(2, "doing", "beta")],
    blocked: [],
    review: [],
    done: [],
  };
  const out = renderBoard(grouped, { color: false });
  for (const col of COLUMNS) {
    expect(out).toContain(col);
  }
});

test("renderBoard: tasks appear under their column header", () => {
  const grouped: Record<string, TaskData[]> = {
    backlog: [makeTask(1, "backlog", "alpha"), makeTask(2, "backlog", "beta")],
    ready: [],
    doing: [],
    blocked: [],
    review: [],
    done: [],
  };
  const out = renderBoard(grouped, { color: false });
  expect(out).toContain("#1");
  expect(out).toContain("alpha");
  expect(out).toContain("#2");
  expect(out).toContain("beta");
});

test("renderBoard: empty column shows (empty) marker", () => {
  const grouped: Record<string, TaskData[]> = {
    backlog: [],
    ready: [],
    doing: [],
    blocked: [],
    review: [],
    done: [],
  };
  const out = renderBoard(grouped, { color: false });
  // Should have at least one (empty) marker for all-empty columns
  expect(out).toContain("(empty)");
});

test("renderBoard pinned layout: stacked sections with empty columns", () => {
  const grouped: Record<string, TaskData[]> = {
    backlog: [makeTask(1, "backlog", "alpha"), makeTask(2, "backlog", "beta")],
    ready: [],
    doing: [],
    blocked: [],
    review: [],
    done: [],
  };
  const out = renderBoard(grouped, { color: false });
  const lines = out.split("\n");

  // backlog header comes before ready header
  const backlogIdx = lines.findIndex((l) => l.trim() === "backlog");
  const readyIdx = lines.findIndex((l) => l.trim() === "ready");
  expect(backlogIdx).toBeGreaterThanOrEqual(0);
  expect(readyIdx).toBeGreaterThanOrEqual(0);
  expect(backlogIdx).toBeLessThan(readyIdx);

  // task lines appear between backlog and ready
  const alphaIdx = lines.findIndex((l) => l.includes("alpha"));
  expect(alphaIdx).toBeGreaterThan(backlogIdx);
  expect(alphaIdx).toBeLessThan(readyIdx);
});

test("renderBoard with color: false has no ANSI escapes", () => {
  const grouped: Record<string, TaskData[]> = {
    backlog: [makeTask(1, "backlog", "a task")],
    ready: [],
    doing: [],
    blocked: [],
    review: [],
    done: [],
  };
  const out = renderBoard(grouped, { color: false });
  expect(out).not.toMatch(/\x1b\[/);
});

test("renderBoard with color: true strips to same plain output", () => {
  const grouped: Record<string, TaskData[]> = {
    backlog: [makeTask(1, "backlog", "colorful task")],
    ready: [],
    doing: [],
    blocked: [],
    review: [],
    done: [],
  };
  const colored = renderBoard(grouped, { color: true });
  const plain = renderBoard(grouped, { color: false });
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  expect(stripAnsi(colored)).toBe(plain);
});

// ─── CLI E2E: tasks board on uninitialized store ─────────────────────────────

test("tasks board on uninitialized store exits non-zero with NOT_INITIALIZED (plain)", async () => {
  const { exitCode, stderr } = await runTasks(["board"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("NOT_INITIALIZED");
});

test("tasks board --json on uninitialized store exits non-zero with NOT_INITIALIZED (json)", async () => {
  const { exitCode, stderr } = await runTasks(["board", "--json"]);
  expect(exitCode).not.toBe(0);
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const error = parsed.error as Record<string, unknown>;
  expect(error.code).toBe("NOT_INITIALIZED");
});

// ─── CLI E2E: tasks board human output ──────────────────────────────────────

test("tasks board shows all six columns in stacked sections", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "alpha");
  plantTask(storeDir, "doing", 2, "beta");
  const git = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: storeDir, stdout: "pipe", stderr: "pipe" }).exited;
  await git(["add", "."]);
  await git(["commit", "-m", "seed tasks"]);

  const { exitCode, stdout } = await runTasks(["board"]);
  expect(exitCode).toBe(0);

  for (const col of COLUMNS) {
    expect(stdout).toContain(col);
  }
  expect(stdout).toContain("alpha");
  expect(stdout).toContain("beta");
  expect(stdout).toContain("(empty)");
});

test("tasks board honors --no-color", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  const git = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: storeDir, stdout: "pipe", stderr: "pipe" }).exited;
  await git(["add", "."]);
  await git(["commit", "-m", "seed"]);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"]);
  expect(exitCode).toBe(0);
  expect(stdout).not.toMatch(/\x1b\[/);
});

// ─── CLI E2E: tasks board --json ─────────────────────────────────────────────

test("tasks board --json returns object with all six column keys", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "alpha");
  plantTask(storeDir, "ready", 2, "beta");
  const git = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: storeDir, stdout: "pipe", stderr: "pipe" }).exited;
  await git(["add", "."]);
  await git(["commit", "-m", "seed"]);

  const { exitCode, stdout } = await runTasks(["board", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  for (const col of COLUMNS) {
    expect(parsed).toHaveProperty(col);
    expect(Array.isArray(parsed[col])).toBe(true);
  }

  // backlog has 1 task, ready has 1 task, rest are empty
  expect((parsed.backlog as unknown[]).length).toBe(1);
  expect((parsed.ready as unknown[]).length).toBe(1);
  expect((parsed.doing as unknown[]).length).toBe(0);
  expect((parsed.blocked as unknown[]).length).toBe(0);
  expect((parsed.review as unknown[]).length).toBe(0);
  expect((parsed.done as unknown[]).length).toBe(0);

  // tasks have the expected structure
  const t = (parsed.backlog as Array<Record<string, unknown>>)[0];
  expect(t.id).toBe(1);
  expect(t.title).toBe("alpha");
  expect(t.column).toBe("backlog");
  expect(typeof t.uuid).toBe("string");
  expect(Array.isArray(t.deps)).toBe(true);
});

test("tasks board --json on empty (initialized) store returns all six columns with empty arrays", async () => {
  // Seed a task to force init, then we still get 1-task board
  // For truly empty board, use initBareStore with no tasks planted
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  for (const col of COLUMNS) {
    expect(parsed).toHaveProperty(col);
    expect((parsed[col] as unknown[]).length).toBe(0);
  }
});
