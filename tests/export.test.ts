import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-export-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-export-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

async function runTasks(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

// ─── Slice 1: empty store ────────────────────────────────────────────────────

test("tasks export --json on initialized empty store returns envelope with no tasks", async () => {
  // init the store explicitly (Read commands never auto-init).
  const init = await runTasks(["init", "--json"]);
  expect(init.exitCode).toBe(0);

  const { exitCode, stdout } = await runTasks(["export", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(parsed.ok).toBe(true);
  expect(parsed.schema_version).toBe("1");
  expect(typeof parsed.head_sha).toBe("string");
  expect((parsed.head_sha as string).length).toBeGreaterThanOrEqual(40);
  expect(parsed.tasks).toEqual([]);
  expect(parsed.reverse_deps).toEqual({});
});

// ─── Error path: running outside a Store ─────────────────────────────────────

test("tasks export --json on uninitialized store exits non-zero with error envelope and does NOT create the store", async () => {
  const { exitCode, stderr } = await runTasks(["export", "--json"]);
  expect(exitCode).not.toBe(0);

  // Must not have auto-initialized.
  const projectsDir = join(tasksHome, "projects");
  expect(existsSync(projectsDir)).toBe(false);

  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("NOT_INITIALIZED");
});

// ─── Slice 2: single task in `ready` with body + AC ──────────────────────────

test("tasks export --json: single ready task carries frontmatter, body, and parsed acceptance_criteria", async () => {
  const body = [
    "Some intro prose.",
    "",
    "## Acceptance Criteria",
    "- one",
    "- two",
    "",
    "## Notes",
    "trailing section that should NOT be in AC",
  ].join("\n");

  // Create task with a body via --body -, then move to ready.
  const newProc = Bun.spawn(
    ["bun", "run", cliPath, "new", "task with body", "--body", "-"],
    {
      env: { ...process.env, TASKS_HOME: tasksHome },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: cwdDir,
    },
  );
  newProc.stdin.write(body);
  newProc.stdin.end();
  const newExit = await newProc.exited;
  expect(newExit).toBe(0);

  const mv = await runTasks(["mv", "1", "ready"]);
  expect(mv.exitCode).toBe(0);

  const { exitCode, stdout } = await runTasks(["export", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const tasks = parsed.tasks as Array<Record<string, unknown>>;
  expect(tasks).toHaveLength(1);

  const t = tasks[0];
  expect(t.id).toBe(1);
  expect(t.title).toBe("task with body");
  expect(t.column).toBe("ready");
  expect(typeof t.uuid).toBe("string");
  expect(typeof t.created_at).toBe("string");
  expect(typeof t.updated_at).toBe("string");
  expect(Array.isArray(t.deps)).toBe(true);
  expect(t.attendance).toBe("attended");
  expect(t.effort).toBe("medium");
  expect(typeof t.body).toBe("string");
  expect(t.body as string).toContain("## Acceptance Criteria");
  expect(t.body as string).toContain("## Notes");
  expect(t.acceptance_criteria).toBe("- one\n- two");
});

// ─── Slice 3: ordering by column, then created_at within column ──────────────

test("tasks export --json: tasks grouped by canonical column order, sorted by created_at within column", async () => {
  // Create 4 tasks. Move them into different columns and exercise within-column
  // ordering by created_at. Default creation order is backlog with id ascending.
  await runTasks(["new", "alpha"]);
  await runTasks(["new", "beta"]);
  await runTasks(["new", "gamma"]);
  await runTasks(["new", "delta"]);

  // alpha -> done, beta -> ready, gamma -> doing, delta -> ready
  await runTasks(["mv", "1", "done"]);
  await runTasks(["mv", "2", "ready"]);
  await runTasks(["mv", "3", "doing"]);
  await runTasks(["mv", "4", "ready"]);

  const { exitCode, stdout } = await runTasks(["export", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const tasks = parsed.tasks as Array<Record<string, unknown>>;
  expect(tasks.map((t) => t.title)).toEqual(["beta", "delta", "gamma", "alpha"]);
  // Columns ordered: backlog, ready, doing, blocked, review, done
  expect(tasks.map((t) => t.column)).toEqual(["ready", "ready", "doing", "done"]);
});

// ─── Slice 4: reverse_deps populated for live→live deps ──────────────────────

test("tasks export --json: reverse_deps indexes live tasks that depend on each task", async () => {
  await runTasks(["new", "blocker"]);
  await runTasks(["new", "dependent A"]);
  await runTasks(["new", "dependent B"]);

  // 2 and 3 both depend on 1
  await runTasks(["link", "2", "--depends-on", "1"]);
  await runTasks(["link", "3", "--depends-on", "1"]);

  const { exitCode, stdout } = await runTasks(["export", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const tasks = parsed.tasks as Array<Record<string, unknown>>;
  const byId = new Map(tasks.map((t) => [t.id as number, t]));
  const blockerUuid = byId.get(1)!.uuid as string;
  const aUuid = byId.get(2)!.uuid as string;
  const bUuid = byId.get(3)!.uuid as string;

  const rd = parsed.reverse_deps as Record<string, string[]>;
  expect(rd[blockerUuid]).toBeDefined();
  expect(new Set(rd[blockerUuid])).toEqual(new Set([aUuid, bUuid]));
  // No reverse deps for leaf nodes.
  expect(rd[aUuid]).toBeUndefined();
  expect(rd[bUuid]).toBeUndefined();
});

// ─── Slice 5: archive stub for archived dep ──────────────────────────────────

test("tasks export --json: archived task referenced as a live dep appears as a stub, full archive omitted", async () => {
  // 1 = the eventual blocker (move to done then archive).
  await runTasks(["new", "blocker old"]);
  // 2 = the dependent (depends on 1).
  await runTasks(["new", "dependent"]);
  await runTasks(["link", "2", "--depends-on", "1"]);
  // 3 = an unrelated done task that we'll also archive (to verify the full
  // archive is NOT included by default).
  await runTasks(["new", "unrelated"]);

  // Move 1 and 3 to done and archive them.
  await runTasks(["mv", "1", "done"]);
  await runTasks(["mv", "3", "done"]);
  await runTasks(["archive", "1"]);
  await runTasks(["archive", "3"]);

  const { exitCode, stdout } = await runTasks(["export", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const tasks = parsed.tasks as Array<Record<string, unknown>>;

  // Live: only the dependent (id 2).
  const live = tasks.filter((t) => t.column !== "archive");
  expect(live.map((t) => t.id)).toEqual([2]);

  // Archive entries: only id 1 (stub), NOT id 3.
  const archived = tasks.filter((t) => t.column === "archive");
  expect(archived.map((t) => t.id)).toEqual([1]);
  const stub = archived[0];
  expect(stub.complete).toBe(true);
  expect(stub.title).toBe("blocker old");
  expect(typeof stub.uuid).toBe("string");
  // Stub has no body / no AC.
  expect(stub.body).toBeUndefined();
  expect(stub.acceptance_criteria).toBeUndefined();
});

// ─── Slice 6: --include-archived includes full archive, no duplicates ────────

test("tasks export --json --include-archived: full archive group with bodies, no duplicate stubs", async () => {
  await runTasks(["new", "blocker old"]);
  await runTasks(["new", "dependent"]);
  await runTasks(["link", "2", "--depends-on", "1"]);
  await runTasks(["new", "unrelated"]);

  await runTasks(["mv", "1", "done"]);
  await runTasks(["mv", "3", "done"]);
  await runTasks(["archive", "1"]);
  await runTasks(["archive", "3"]);

  const { exitCode, stdout } = await runTasks(["export", "--json", "--include-archived"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const tasks = parsed.tasks as Array<Record<string, unknown>>;

  const archived = tasks.filter((t) => t.column === "archive");
  // Both archived tasks present, exactly once each (no stub + full duplication).
  expect(archived.map((t) => t.id).sort()).toEqual([1, 3]);

  for (const t of archived) {
    expect(t.complete).toBe(true);
    // Full archive form carries body + AC, unlike the stub.
    expect(typeof t.body).toBe("string");
    expect(typeof t.acceptance_criteria).toBe("string");
  }
});

// ─── Slice 7: --columns filters live tasks, stubs still emitted ──────────────

test("tasks export --json --columns ready,doing restricts live tasks; archive stubs still appear for in-scope deps", async () => {
  // backlog task that should be filtered out.
  await runTasks(["new", "background work"]);
  // live dependent in ready, depends on an archived task.
  await runTasks(["new", "archived blocker"]);
  await runTasks(["new", "live dependent"]);
  await runTasks(["link", "3", "--depends-on", "2"]);
  await runTasks(["mv", "2", "done"]);
  await runTasks(["archive", "2"]);
  await runTasks(["mv", "3", "ready"]);

  const { exitCode, stdout } = await runTasks([
    "export",
    "--json",
    "--columns",
    "ready,doing",
  ]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const tasks = parsed.tasks as Array<Record<string, unknown>>;

  const live = tasks.filter((t) => t.column !== "archive");
  // Only the live dependent (#3 in ready).
  expect(live.map((t) => t.id)).toEqual([3]);
  // Background-work backlog task is filtered out.
  expect(live.some((t) => t.id === 1)).toBe(false);

  // The archived blocker (#2) should still appear as a stub because the
  // in-scope live task depends on it.
  const archived = tasks.filter((t) => t.column === "archive");
  expect(archived.map((t) => t.id)).toEqual([2]);
  expect(archived[0].complete).toBe(true);
});
