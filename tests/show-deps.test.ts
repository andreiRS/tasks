import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-show-deps-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-show-deps-cwd-"));
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

// ─── Test 1: JSON — task with no deps has empty arrays ───────────────────────

test("show --json: task with no deps has empty deps_out and deps_in arrays", async () => {
  await plantTask("solo task");
  const { exitCode, stdout } = await runTasks(["show", "1", "--json"]);
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(Array.isArray(parsed.deps_out)).toBe(true);
  expect(Array.isArray(parsed.deps_in)).toBe(true);
  expect((parsed.deps_out as unknown[]).length).toBe(0);
  expect((parsed.deps_in as unknown[]).length).toBe(0);
});

// ─── Test 2: JSON forward edges in dep-array order ────────────────────────────

test("show --json: deps_out lists forward edges in dep-array order with uuid/id/title", async () => {
  const a = await plantTask("task A");
  const b = await plantTask("task B");
  const c = await plantTask("task C");

  // Link A --depends-on B, then C (order matters)
  const linkRes = await runTasks(["link", String(a.id), "--depends-on", String(b.id), "--depends-on", String(c.id)]);
  expect(linkRes.exitCode).toBe(0);

  const { exitCode, stdout } = await runTasks(["show", String(a.id), "--json"]);
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as { deps_out: Array<{ uuid: string; id: number; title: string }>; deps_in: unknown[] };

  expect(parsed.deps_out.length).toBe(2);
  expect(parsed.deps_out[0]).toEqual({ uuid: b.uuid, id: b.id, title: "task B" });
  expect(parsed.deps_out[1]).toEqual({ uuid: c.uuid, id: c.id, title: "task C" });
  expect(parsed.deps_in.length).toBe(0);
});

// ─── Test 3: JSON reverse edges sorted by short id ascending ──────────────────

test("show --json: deps_in lists reverse edges sorted by short id ascending", async () => {
  const a = await plantTask("task A");
  const b = await plantTask("task B");
  const c = await plantTask("task C");

  // Both A and B depend on C
  let r = await runTasks(["link", String(a.id), "--depends-on", String(c.id)]);
  expect(r.exitCode).toBe(0);
  r = await runTasks(["link", String(b.id), "--depends-on", String(c.id)]);
  expect(r.exitCode).toBe(0);

  const { exitCode, stdout } = await runTasks(["show", String(c.id), "--json"]);
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as { deps_in: Array<{ uuid: string; id: number; title: string }>; deps_out: unknown[] };

  expect(parsed.deps_out.length).toBe(0);
  expect(parsed.deps_in.length).toBe(2);
  // Sorted by id ascending: A first (id=1), then B (id=2)
  expect(parsed.deps_in[0]).toEqual({ uuid: a.uuid, id: a.id, title: "task A" });
  expect(parsed.deps_in[1]).toEqual({ uuid: b.uuid, id: b.id, title: "task B" });
});

// ─── Test 4: Human mode — Depends on section ──────────────────────────────────

test("show (human): A depending on B renders 'Depends on:' block with '#<id> <title>'", async () => {
  const a = await plantTask("task A");
  const b = await plantTask("task B");

  const linkRes = await runTasks(["link", String(a.id), "--depends-on", String(b.id)]);
  expect(linkRes.exitCode).toBe(0);

  const { exitCode, stdout } = await runTasks(["show", String(a.id), "--no-color"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Depends on:");
  expect(stdout).toContain(`  #${b.id} task B`);
  // No "Blocks:" since A is not depended on
  expect(stdout).not.toContain("Blocks:");
});

// ─── Test 5: Human mode — Blocks section ──────────────────────────────────────

test("show (human): C with A,B depending on it renders 'Blocks:' block", async () => {
  const a = await plantTask("task A");
  const b = await plantTask("task B");
  const c = await plantTask("task C");

  let r = await runTasks(["link", String(a.id), "--depends-on", String(c.id)]);
  expect(r.exitCode).toBe(0);
  r = await runTasks(["link", String(b.id), "--depends-on", String(c.id)]);
  expect(r.exitCode).toBe(0);

  const { exitCode, stdout } = await runTasks(["show", String(c.id), "--no-color"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Blocks:");
  expect(stdout).toContain(`  #${a.id} task A`);
  expect(stdout).toContain(`  #${b.id} task B`);
  expect(stdout).not.toContain("Depends on:");
});

// ─── Test 6: Human mode — neither header when no edges ────────────────────────

test("show (human): task with no edges prints neither 'Depends on:' nor 'Blocks:'", async () => {
  await plantTask("solo task");
  const { exitCode, stdout } = await runTasks(["show", "1", "--no-color"]);
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("Depends on:");
  expect(stdout).not.toContain("Blocks:");
});
