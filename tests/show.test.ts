import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-show-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-show-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

/**
 * Helper: run `tasks new "hello world"` to seed a task in the store.
 * Returns the spawned process after waiting for it to complete.
 */
async function seedTask(title: string = "hello world"): Promise<void> {
  const proc = Bun.spawn(["bun", "run", cliPath, "new", title], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`seedTask failed (exit ${exitCode}): ${err}`);
  }
}

/**
 * Helper: run a tasks command and return {exitCode, stdout, stderr}.
 */
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

// ─── Test 1: happy path by short id ─────────────────────────────────────────

test("tasks show 1 --json returns structured task with correct fields", async () => {
  await seedTask("hello world");

  const { exitCode, stdout } = await runTasks(["show", "1", "--json"]);

  expect(exitCode).toBe(0);

  let parsed: Record<string, unknown>;
  expect(() => { parsed = JSON.parse(stdout); }).not.toThrow();
  parsed = JSON.parse(stdout);

  expect(parsed.id).toBe(1);
  expect(typeof parsed.uuid).toBe("string");
  expect(parsed.uuid as string).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  expect(parsed.title).toBe("hello world");
  expect(parsed.column).toBe("backlog");

  // timestamps: valid ISO-8601, equal, strings
  expect(typeof parsed.created_at).toBe("string");
  expect(typeof parsed.updated_at).toBe("string");
  expect(new Date(parsed.created_at as string).toISOString()).toBe(parsed.created_at as string);
  expect(new Date(parsed.updated_at as string).toISOString()).toBe(parsed.updated_at as string);
  expect(parsed.created_at).toBe(parsed.updated_at);

  // body: empty string for freshly created task
  expect(parsed.body).toBe("");

  // deps: empty array (normalized default)
  expect(Array.isArray(parsed.deps)).toBe(true);
  expect((parsed.deps as unknown[]).length).toBe(0);

  // flags: normalized defaults
  expect(parsed.agent_ready).toBe(false);
  expect(parsed.human_in_loop).toBe(false);
});

// ─── Test 2: lookup by UUID ───────────────────────────────────────────────────

test("tasks show <uuid> --json returns the same task as show 1 --json", async () => {
  await seedTask("hello world");

  // First get the uuid via short id
  const byId = await runTasks(["show", "1", "--json"]);
  expect(byId.exitCode).toBe(0);
  const idParsed = JSON.parse(byId.stdout) as Record<string, unknown>;
  const uuid = idParsed.uuid as string;

  // Now look up by uuid
  const byUuid = await runTasks(["show", uuid, "--json"]);
  expect(byUuid.exitCode).toBe(0);

  let uuidParsed: Record<string, unknown>;
  expect(() => { uuidParsed = JSON.parse(byUuid.stdout); }).not.toThrow();
  uuidParsed = JSON.parse(byUuid.stdout);

  // Should be the same task
  expect(uuidParsed.id).toBe(1);
  expect(uuidParsed.uuid).toBe(uuid);
  expect(uuidParsed.title).toBe("hello world");
  expect(uuidParsed.column).toBe("backlog");
});

// ─── Test 3: not found by short id with --json ────────────────────────────────

test("tasks show 999 --json exits non-zero with JSON error envelope NOT_FOUND", async () => {
  await seedTask("hello world");

  const { exitCode, stderr } = await runTasks(["show", "999", "--json"]);

  expect(exitCode).not.toBe(0);

  let parsed: Record<string, unknown>;
  expect(() => { parsed = JSON.parse(stderr); }).not.toThrow();
  parsed = JSON.parse(stderr);

  expect(parsed).toHaveProperty("error");
  const error = parsed.error as Record<string, unknown>;
  expect(error.code).toBe("NOT_FOUND");
  expect(typeof error.message).toBe("string");
  expect(typeof error.details).toBe("object");
  expect(error.details).not.toBeNull();
});

// ─── Test 4: not found without --json gives plain text ────────────────────────

test("tasks show 999 without --json exits non-zero with plain-text NOT_FOUND on stderr", async () => {
  await seedTask("hello world");

  const { exitCode, stderr } = await runTasks(["show", "999"]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("NOT_FOUND");

  // Must NOT be a JSON envelope — plain text only
  expect(() => JSON.parse(stderr)).toThrow();
});

// ─── Test 5: read command does NOT auto-init ──────────────────────────────────

test("tasks show 1 --json in fresh TASKS_HOME does NOT create the store dir", async () => {
  // Do NOT seed anything — fresh tasksHome and cwdDir

  const { exitCode } = await runTasks(["show", "1", "--json"]);

  // Should be NOT_FOUND (non-zero), not a crash
  expect(exitCode).not.toBe(0);

  // The projects dir must not have been created
  const projectsDir = join(tasksHome, "projects");
  expect(existsSync(projectsDir)).toBe(false);
});
