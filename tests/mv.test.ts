import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-mv-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-mv-cwd-"));
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

/** Plant a task, return its short id (always 1 for first task). */
async function plantTask(title: string = "a task"): Promise<number> {
  const { exitCode, stderr } = await runTasks(["new", title]);
  if (exitCode !== 0) throw new Error(`plantTask failed: ${stderr}`);
  return 1;
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
  // The store encodes cwd (or its .git root). Since cwdDir has no .git, it uses cwdDir.
  // Use realpathSync to resolve macOS /var -> /private/var symlinks.
  // Encoding: `-` -> `--`, `/` -> `-`
  const realCwd = realpathSync(cwdDir);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

/** Read frontmatter from a task file. */
function readFrontmatter(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, "utf-8");
  const parts = raw.split(/^---\s*$/m);
  if (parts.length < 3) throw new Error("No frontmatter found");
  return parseYaml(parts[1]) as Record<string, unknown>;
}

/** Find the single .md file in a column dir (or null). */
function findFileInColumn(storeDir: string, col: string): string | null {
  const colDir = join(storeDir, col);
  if (!existsSync(colDir)) return null;
  const files = readdirSync(colDir).filter((f) => f.endsWith(".md"));
  return files.length > 0 ? join(colDir, files[0]) : null;
}

// ─── Test 1: happy path: move to different column ────────────────────────────

test("tasks mv moves task from backlog to ready: file moves, updated_at advances, single new commit", async () => {
  await plantTask("my task");

  const storeDir = deriveStoreDir();

  // Read updated_at before move
  const beforeFile = findFileInColumn(storeDir, "backlog");
  expect(beforeFile).not.toBeNull();
  const fmBefore = readFrontmatter(beforeFile!);
  const updatedBefore = fmBefore.updated_at as string;

  const commitsBefore = await gitLogCount(storeDir);

  // Small delay so updated_at definitely advances
  await new Promise((r) => setTimeout(r, 10));

  const { exitCode } = await runTasks(["mv", "1", "ready"]);
  expect(exitCode).toBe(0);

  // File must be gone from backlog
  expect(findFileInColumn(storeDir, "backlog")).toBeNull();

  // File must exist in ready
  const readyFile = findFileInColumn(storeDir, "ready");
  expect(readyFile).not.toBeNull();

  // updated_at must have advanced
  const fmAfter = readFrontmatter(readyFile!);
  const updatedAfter = fmAfter.updated_at as string;
  expect(new Date(updatedAfter).getTime()).toBeGreaterThanOrEqual(new Date(updatedBefore).getTime());

  // Exactly one new commit
  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore + 1);
});

// ─── Test 2: same-column no-op ────────────────────────────────────────────────

test("tasks mv to same column is a no-op: exit 0, no new commit, file unchanged", async () => {
  await plantTask("no-op task");

  const storeDir = deriveStoreDir();

  const commitsBefore = await gitLogCount(storeDir);

  const beforeFile = findFileInColumn(storeDir, "backlog")!;
  const fmBefore = readFrontmatter(beforeFile);
  const updatedBefore = fmBefore.updated_at as string;

  const { exitCode } = await runTasks(["mv", "1", "backlog"]);
  expect(exitCode).toBe(0);

  // No new commit
  expect(await gitLogCount(storeDir)).toBe(commitsBefore);

  // File still in backlog, updated_at unchanged
  const afterFile = findFileInColumn(storeDir, "backlog")!;
  const fmAfter = readFrontmatter(afterFile);
  expect(fmAfter.updated_at).toBe(updatedBefore);
});

// ─── Test 3: invalid column (plain text) ─────────────────────────────────────

test("tasks mv to unknown column prints INVALID_COLUMN on stderr and exits non-zero", async () => {
  await plantTask("col test");

  const { exitCode, stderr } = await runTasks(["mv", "1", "limbo"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_COLUMN");
  // plain text, not JSON
  expect(() => JSON.parse(stderr)).toThrow();
});

// ─── Test 4: invalid column with --json ──────────────────────────────────────

test("tasks mv to unknown column with --json emits JSON envelope INVALID_COLUMN", async () => {
  await plantTask("col test json");

  const { exitCode, stderr } = await runTasks(["mv", "1", "limbo", "--json"]);
  expect(exitCode).not.toBe(0);

  let parsed: Record<string, unknown>;
  expect(() => { parsed = JSON.parse(stderr); }).not.toThrow();
  parsed = JSON.parse(stderr);
  expect((parsed.error as Record<string, unknown>).code).toBe("INVALID_COLUMN");
});

// ─── Test 5: not found (plain text) ──────────────────────────────────────────

test("tasks mv with unknown id prints NOT_FOUND on stderr and exits non-zero", async () => {
  await plantTask("found task");

  const { exitCode, stderr } = await runTasks(["mv", "999", "ready"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("NOT_FOUND");
  expect(() => JSON.parse(stderr)).toThrow();
});

// ─── Test 6: not found with --json ───────────────────────────────────────────

test("tasks mv with unknown id and --json emits JSON envelope NOT_FOUND", async () => {
  await plantTask("found task json");

  const { exitCode, stderr } = await runTasks(["mv", "999", "ready", "--json"]);
  expect(exitCode).not.toBe(0);
  let parsed: Record<string, unknown>;
  expect(() => { parsed = JSON.parse(stderr); }).not.toThrow();
  parsed = JSON.parse(stderr);
  expect((parsed.error as Record<string, unknown>).code).toBe("NOT_FOUND");
});

// ─── Test 7: dirty-tree guard ─────────────────────────────────────────────────

test("tasks mv refuses with STORE_DIRTY when the working tree has uncommitted changes", async () => {
  await plantTask("dirty task");

  const storeDir = deriveStoreDir();

  // Stage a dirty file directly in the store
  writeFileSync(join(storeDir, "dirty.txt"), "mess\n", "utf-8");
  const gitBin = Bun.which("git") ?? "/opt/homebrew/bin/git";
  const addProc = Bun.spawn([gitBin, "add", "dirty.txt"], { cwd: storeDir, stdout: "pipe", stderr: "pipe" });
  await addProc.exited;

  const { exitCode, stderr } = await runTasks(["mv", "1", "ready"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("STORE_DIRTY");
});

// ─── Test 8: accepts UUID form ────────────────────────────────────────────────

test("tasks mv accepts UUID instead of short id", async () => {
  await plantTask("uuid task");

  // Get the UUID
  const { stdout } = await runTasks(["show", "1", "--json"]);
  const task = JSON.parse(stdout) as Record<string, unknown>;
  const uuid = task.uuid as string;

  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode } = await runTasks(["mv", uuid, "doing"]);
  expect(exitCode).toBe(0);

  // File should be in doing
  expect(findFileInColumn(storeDir, "doing")).not.toBeNull();
  expect(await gitLogCount(storeDir)).toBe(commitsBefore + 1);
});

// ─── Test 9: --json success envelope ─────────────────────────────────────────

test("tasks mv --json emits success envelope with ok/id/uuid/from/to", async () => {
  await plantTask("json mv task");

  const { stdout: showOut } = await runTasks(["show", "1", "--json"]);
  const task = JSON.parse(showOut) as Record<string, unknown>;
  const uuid = task.uuid as string;

  const { exitCode, stdout, stderr } = await runTasks(["mv", "1", "ready", "--json"]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");

  let parsed: Record<string, unknown>;
  expect(() => { parsed = JSON.parse(stdout); }).not.toThrow();
  parsed = JSON.parse(stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.id).toBe(1);
  expect(parsed.uuid).toBe(uuid);
  expect(parsed.from).toBe("backlog");
  expect(parsed.to).toBe("ready");
});

// ─── Test 10: --json same-column no-op envelope ───────────────────────────────

test("tasks mv --json same-column no-op emits envelope with from === to", async () => {
  await plantTask("noop json task");

  const { stdout: showOut } = await runTasks(["show", "1", "--json"]);
  const task = JSON.parse(showOut) as Record<string, unknown>;
  const uuid = task.uuid as string;

  const { exitCode, stdout, stderr } = await runTasks(["mv", "1", "backlog", "--json"]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");

  let parsed: Record<string, unknown>;
  expect(() => { parsed = JSON.parse(stdout); }).not.toThrow();
  parsed = JSON.parse(stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.id).toBe(1);
  expect(parsed.uuid).toBe(uuid);
  expect(parsed.from).toBe("backlog");
  expect(parsed.to).toBe("backlog");
});
