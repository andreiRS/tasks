import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-rmcasc-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-rmcasc-cwd-"));
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

async function plantTask(title: string): Promise<number> {
  const { exitCode, stdout, stderr } = await runTasks(["new", title]);
  if (exitCode !== 0) throw new Error(`plantTask failed: ${stderr}`);
  const m = /new #(\d+)/.exec(stdout);
  if (!m) throw new Error(`plantTask: bad stdout ${stdout}`);
  return parseInt(m[1], 10);
}

async function getTaskJson(idOrUuid: string | number): Promise<Record<string, unknown>> {
  const { exitCode, stdout, stderr } = await runTasks(["show", String(idOrUuid), "--json"]);
  if (exitCode !== 0) throw new Error(`getTaskJson failed: ${stderr}`);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function deriveStoreDir(): string {
  const realCwd = realpathSync(cwdDir);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

function filesInColumn(storeDir: string, col: string): string[] {
  const colDir = join(storeDir, col);
  if (!existsSync(colDir)) return [];
  return readdirSync(colDir).filter((f) => f.endsWith(".md"));
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

/** Inject a deps list into a task file directly on disk (bypasses CLI). */
function injectDeps(storeDir: string, col: string, id: number, depUuids: string[]): void {
  const colDir = join(storeDir, col);
  const files = readdirSync(colDir).filter((f) => f.startsWith(`${id}-`) && f.endsWith(".md"));
  if (files.length === 0) throw new Error(`injectDeps: task ${id} not found in ${col}`);
  const filePath = join(colDir, files[0]);
  const raw = readFileSync(filePath, "utf-8");
  const parts = raw.split(/^---\s*$/m);
  const fm = parseYaml(parts[1]) as Record<string, unknown>;
  // Build the deps YAML inline list
  const depsYaml = depUuids.length === 0 ? "[]" : `[${depUuids.map((u) => `"${u}"`).join(", ")}]`;
  // Replace the deps: line (or insert if absent)
  let newFm: string;
  if (/^deps:/m.test(parts[1])) {
    newFm = parts[1].replace(/^deps:.*$/m, `deps: ${depsYaml}`);
  } else {
    newFm = parts[1].trimEnd() + `\ndeps: ${depsYaml}\n`;
  }
  const newContent = `---${newFm}---${parts.slice(2).join("---")}`;
  writeFileSync(filePath, newContent, "utf-8");

  // Commit the mutation so the store stays clean
  const gitBin = Bun.which("git") ?? "/opt/homebrew/bin/git";
  const relPath = `${col}/${files[0]}`;
  const addProc = Bun.spawnSync([gitBin, "add", relPath], { cwd: storeDir });
  if (addProc.exitCode !== 0) throw new Error("injectDeps git add failed");
  const commitProc = Bun.spawnSync(
    [gitBin, "commit", "-m", `test: inject deps into #${id}`],
    { cwd: storeDir },
  );
  if (commitProc.exitCode !== 0) throw new Error("injectDeps git commit failed");
}

// ─── Test 1: rm without --force refuses when a dependent exists ───────────────

test("tasks rm (no force) refuses DEP_EXISTS when a dependent exists, plain text", async () => {
  const idA = await plantTask("task A");
  const idB = await plantTask("task B");
  const storeDir = deriveStoreDir();

  const taskA = await getTaskJson(idA);
  injectDeps(storeDir, "backlog", idB, [taskA.uuid as string]);

  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["rm", String(idA)]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("DEP_EXISTS");
  // No new commit
  expect(await gitLogCount(storeDir)).toBe(commitsBefore);
  // Both tasks still present
  expect(filesInColumn(storeDir, "backlog").length).toBe(2);
  // B's deps still include A's uuid
  const taskBAfter = await getTaskJson(idB);
  expect((taskBAfter.deps as string[])).toContain(taskA.uuid as string);
});

test("tasks rm (no force) refuses DEP_EXISTS in --json envelope", async () => {
  const idA = await plantTask("task A json");
  const idB = await plantTask("task B json");
  const storeDir = deriveStoreDir();

  const taskA = await getTaskJson(idA);
  injectDeps(storeDir, "backlog", idB, [taskA.uuid as string]);

  const { exitCode, stderr } = await runTasks(["rm", String(idA), "--json"]);
  expect(exitCode).not.toBe(0);
  let parsed: Record<string, unknown>;
  expect(() => { parsed = JSON.parse(stderr); }).not.toThrow();
  parsed = JSON.parse(stderr);
  expect((parsed.error as Record<string, unknown>).code).toBe("DEP_EXISTS");
});

// ─── Test 2: rm --force removes A and strips A's uuid from B ─────────────────

test("tasks rm --force removes task and strips uuid from single dependent", async () => {
  const idA = await plantTask("task A force");
  const idB = await plantTask("task B force");
  const storeDir = deriveStoreDir();

  const taskA = await getTaskJson(idA);
  injectDeps(storeDir, "backlog", idB, [taskA.uuid as string]);

  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["rm", String(idA), "--force"]);
  expect(exitCode).toBe(0);

  // A is gone
  for (const col of ["backlog", "ready", "doing", "blocked", "review", "done"]) {
    const files = filesInColumn(storeDir, col);
    for (const f of files) {
      expect(f.startsWith(`${idA}-`)).toBe(false);
    }
  }

  // B's deps no longer contains A's uuid
  const taskBAfter = await getTaskJson(idB);
  expect((taskBAfter.deps as string[])).not.toContain(taskA.uuid as string);
  expect((taskBAfter.deps as string[])).toEqual([]);

  // Exactly ONE new commit
  expect(await gitLogCount(storeDir)).toBe(commitsBefore + 1);

  // B listed in stderr as affected: format "#<id> <title>"
  expect(stderr).toContain(`#${idB}`);
  expect(stderr).toContain("task B force");
});

// ─── Test 3: three-way cascade ────────────────────────────────────────────────

test("tasks rm --force cascades to multiple dependents (B and C both depend on A)", async () => {
  const idA = await plantTask("anchor");
  const idB = await plantTask("dep B");
  const idC = await plantTask("dep C");
  const storeDir = deriveStoreDir();

  const taskA = await getTaskJson(idA);
  injectDeps(storeDir, "backlog", idB, [taskA.uuid as string]);
  injectDeps(storeDir, "backlog", idC, [taskA.uuid as string]);

  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["rm", String(idA), "--force"]);
  expect(exitCode).toBe(0);

  // A is gone
  const allFiles = (["backlog", "ready", "doing", "blocked", "review", "done"] as const).flatMap((col) =>
    filesInColumn(storeDir, col)
  );
  expect(allFiles.some((f) => f.startsWith(`${idA}-`))).toBe(false);

  // B and C have empty deps
  const taskBAfter = await getTaskJson(idB);
  expect((taskBAfter.deps as string[])).toEqual([]);
  const taskCAfter = await getTaskJson(idC);
  expect((taskCAfter.deps as string[])).toEqual([]);

  // Single new commit
  expect(await gitLogCount(storeDir)).toBe(commitsBefore + 1);

  // Both B and C listed in stderr
  expect(stderr).toContain(`#${idB}`);
  expect(stderr).toContain(`#${idC}`);
});

// ─── Test 4: rm --force with no dependents behaves like plain rm ──────────────

test("tasks rm --force with no dependents: succeeds, single commit, no affected output", async () => {
  const idA = await plantTask("lone wolf");
  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["rm", String(idA), "--force"]);
  expect(exitCode).toBe(0);

  // A is gone
  expect(filesInColumn(storeDir, "backlog").length).toBe(0);

  // Single new commit
  expect(await gitLogCount(storeDir)).toBe(commitsBefore + 1);

  // No "affected" noise in stderr (store init messages are ok, but no task ids)
  const relevantStderr = stderr.split("\n").filter((l) => l.includes("#")).join("\n");
  expect(relevantStderr).toBe("");
});
