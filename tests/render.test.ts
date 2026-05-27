import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTask } from "../src/render.ts";
import type { TaskData } from "../src/store.ts";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-render-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-render-cwd-"));
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

// ─── Test 1: renderTask unit, full layout pinned ────────────────────────────

test("renderTask returns the pinned human-readable layout", () => {
  const task: TaskData = {
    id: 42,
    uuid: "7f3a9c2e-1234-4567-89ab-cdef01234567",
    title: "add OAuth flow",
    column: "backlog",
    created_at: "2026-05-27T10:14:00.000Z",
    updated_at: "2026-05-27T10:14:00.000Z",
    body: "Some body text.\n\nWith two paragraphs.",
    deps: [],
    agent_ready: false,
    human_in_loop: false,
  };

  const out = renderTask(task);

  const expected =
    "#42 add OAuth flow\n" +
    "\n" +
    "uuid:          7f3a9c2e-1234-4567-89ab-cdef01234567\n" +
    "column:        backlog\n" +
    "deps:          (none)\n" +
    "agent_ready:   false\n" +
    "human_in_loop: false\n" +
    "created_at:    2026-05-27T10:14:00.000Z\n" +
    "updated_at:    2026-05-27T10:14:00.000Z\n" +
    "\n" +
    "Some body text.\n" +
    "\n" +
    "With two paragraphs.\n";

  expect(out).toBe(expected);
});

// ─── Test 2: renderTask with deps and flags set ─────────────────────────────

test("renderTask lists deps as UUIDs when present and reflects flags", () => {
  const task: TaskData = {
    id: 7,
    uuid: "aaaaaaaa-1111-4111-8111-111111111111",
    title: "wire up handler",
    column: "doing",
    created_at: "2026-05-01T09:00:00.000Z",
    updated_at: "2026-05-02T09:00:00.000Z",
    body: "",
    deps: [
      "bbbbbbbb-2222-4222-8222-222222222222",
      "cccccccc-3333-4333-8333-333333333333",
    ],
    agent_ready: true,
    human_in_loop: true,
  };

  const out = renderTask(task);

  expect(out).toContain("#7 wire up handler");
  expect(out).toContain("column:        doing");
  expect(out).toContain("agent_ready:   true");
  expect(out).toContain("human_in_loop: true");
  expect(out).toContain("deps:");
  expect(out).toContain("bbbbbbbb-2222-4222-8222-222222222222");
  expect(out).toContain("cccccccc-3333-4333-8333-333333333333");
  // empty body: still ends with a trailing newline, no double-empty body section
  expect(out.endsWith("\n")).toBe(true);
});

// ─── Test 3: CLI E2E — tasks show <id> without --json renders via renderTask ─

test("tasks show <id> without --json prints the renderTask output", async () => {
  // Seed a task
  const seed = await runTasks(["new", "hello world"]);
  expect(seed.exitCode).toBe(0);

  // Grab the JSON form so we can build the expected rendering
  const j = await runTasks(["show", "1", "--json"]);
  expect(j.exitCode).toBe(0);
  const task = JSON.parse(j.stdout) as TaskData;

  // Now human render
  const { exitCode, stdout } = await runTasks(["show", "1"]);
  expect(exitCode).toBe(0);

  const expected = renderTask(task);
  expect(stdout).toBe(expected);

  // Sanity: the output is non-trivial — title header line AND metadata block
  expect(stdout).toContain("#1 hello world");
  expect(stdout).toContain("uuid:");
  expect(stdout).toContain("column:        backlog");
  expect(stdout).toContain("created_at:");
});

// ─── Color handling tests ───────────────────────────────────────────────────

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const sampleTask: TaskData = {
  id: 42,
  uuid: "7f3a9c2e-1234-4567-89ab-cdef01234567",
  title: "add OAuth flow",
  column: "backlog",
  created_at: "2026-05-27T10:14:00.000Z",
  updated_at: "2026-05-27T10:14:00.000Z",
  body: "Some body text.",
  deps: [],
  agent_ready: false,
  human_in_loop: false,
};

test("renderTask with color: false contains no ANSI escapes", () => {
  const out = renderTask(sampleTask, { color: false });
  expect(out).not.toMatch(/\x1b\[/);
});

test("renderTask with color: true contains ANSI escapes and strips to the plain rendering", () => {
  const colored = renderTask(sampleTask, { color: true });
  const plain = renderTask(sampleTask, { color: false });
  expect(colored).toMatch(/\x1b\[/);
  expect(stripAnsi(colored)).toBe(plain);
});

test("renderTask defaults to no color when options omitted", () => {
  const out = renderTask(sampleTask);
  expect(out).not.toMatch(/\x1b\[/);
});

test("tasks show <id> --no-color produces no ANSI escapes even with FORCE_COLOR=1", async () => {
  const seed = await runTasks(["new", "hello world"]);
  expect(seed.exitCode).toBe(0);

  const proc = Bun.spawn(["bun", "run", cliPath, "show", "1", "--no-color"], {
    env: { ...process.env, TASKS_HOME: tasksHome, FORCE_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).not.toMatch(/\x1b\[/);
});

test("tasks show <id> with FORCE_COLOR=1 emits ANSI escapes", async () => {
  const seed = await runTasks(["new", "hello world"]);
  expect(seed.exitCode).toBe(0);

  const proc = Bun.spawn(["bun", "run", cliPath, "show", "1"], {
    env: { ...process.env, TASKS_HOME: tasksHome, FORCE_COLOR: "1", NO_COLOR: "" },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/\x1b\[/);
  expect(stripAnsi(stdout)).toContain("#1 hello world");
});

test("tasks show <id> with NO_COLOR=1 beats FORCE_COLOR=1", async () => {
  const seed = await runTasks(["new", "hello world"]);
  expect(seed.exitCode).toBe(0);

  const proc = Bun.spawn(["bun", "run", cliPath, "show", "1"], {
    env: { ...process.env, TASKS_HOME: tasksHome, FORCE_COLOR: "1", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).not.toMatch(/\x1b\[/);
});
