import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-set-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-set-cwd-"));
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

function findTaskFile(storeDir: string, column: string): { filename: string; raw: string } {
  const files = readdirSync(join(storeDir, column)).filter((f) => f.endsWith(".md"));
  expect(files).toHaveLength(1);
  return {
    filename: files[0],
    raw: readFileSync(join(storeDir, column, files[0]), "utf-8"),
  };
}

function parseFm(raw: string): Record<string, unknown> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  expect(m).not.toBeNull();
  return parseYaml(m![1]) as Record<string, unknown>;
}

// ─── No flags is an error ─────────────────────────────────────────────────────

test("tasks set with no flags is an error", async () => {
  const t = await plantTask("task A");
  const { exitCode, stderr } = await runTasks(["set", String(t.id)]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("MISSING_FIELD");
});

// ─── --title updates frontmatter and renames file in single commit ────────────

test("tasks set --title updates title, renames file, single commit", async () => {
  const t = await plantTask("original title");
  const storeDir = deriveStoreDir();
  const before = findTaskFile(storeDir, "backlog");
  expect(before.filename).toContain("original-title");
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["set", String(t.id), "--title", "renamed task"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);

  const after = findTaskFile(storeDir, "backlog");
  expect(after.filename).toContain("renamed-task");
  expect(after.filename).not.toBe(before.filename);

  const fm = parseFm(after.raw);
  expect(fm.title).toBe("renamed task");

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore + 1);
});

// ─── --attendance and --effort update enums ───────────────────────────────────

test("tasks set --attendance unattended --effort high writes both and bumps updated_at, single commit", async () => {
  const t = await plantTask("enum task");
  const storeDir = deriveStoreDir();
  const before = findTaskFile(storeDir, "backlog");
  const beforeFm = parseFm(before.raw);
  const beforeUpdated = beforeFm.updated_at as string;
  const commitsBefore = await gitLogCount(storeDir);

  // Ensure clock tick.
  await new Promise((r) => setTimeout(r, 10));

  const { exitCode, stderr } = await runTasks([
    "set", String(t.id),
    "--attendance", "unattended",
    "--effort", "high",
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);

  const after = findTaskFile(storeDir, "backlog");
  const afterFm = parseFm(after.raw);
  expect(afterFm.attendance).toBe("unattended");
  expect(afterFm.effort).toBe("high");
  expect(afterFm.updated_at).not.toBe(beforeUpdated);

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore + 1);
});

// ─── Multiple flags including --title in one invocation = one commit ──────────

test("tasks set with --title plus --effort produces ONE commit and renames file", async () => {
  const t = await plantTask("combo task");
  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode } = await runTasks([
    "set", String(t.id),
    "--title", "combo renamed",
    "--effort", "low",
  ]);
  expect(exitCode).toBe(0);

  const after = findTaskFile(storeDir, "backlog");
  expect(after.filename).toContain("combo-renamed");
  const fm = parseFm(after.raw);
  expect(fm.title).toBe("combo renamed");
  expect(fm.effort).toBe("low");

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore + 1);
});

// ─── INVALID_ATTENDANCE ───────────────────────────────────────────────────────

test("tasks set --attendance bogus returns INVALID_ATTENDANCE", async () => {
  const t = await plantTask("invalid attendance");
  const { exitCode, stderr } = await runTasks(["set", String(t.id), "--attendance", "wrong"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_ATTENDANCE");
});

// ─── INVALID_EFFORT ───────────────────────────────────────────────────────────

test("tasks set --effort gargantuan returns INVALID_EFFORT", async () => {
  const t = await plantTask("invalid effort");
  const { exitCode, stderr } = await runTasks(["set", String(t.id), "--effort", "gargantuan"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_EFFORT");
});

// ─── INVALID_TITLE ────────────────────────────────────────────────────────────

test("tasks set --title '' returns INVALID_TITLE", async () => {
  const t = await plantTask("invalid title");
  const { exitCode, stderr } = await runTasks(["set", String(t.id), "--title", ""]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_TITLE");
});

// ─── NOT_FOUND ────────────────────────────────────────────────────────────────

test("tasks set on unknown id returns NOT_FOUND", async () => {
  await plantTask("exists");
  const { exitCode, stderr } = await runTasks(["set", "999", "--effort", "high"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("NOT_FOUND");
});

// ─── --json success envelope ──────────────────────────────────────────────────

test("tasks set --json emits success envelope; changed only includes set fields", async () => {
  const t = await plantTask("set json task");

  // Set only --effort (not --title or --attendance)
  const { exitCode, stdout, stderr } = await runTasks([
    "set", String(t.id),
    "--effort", "high",
    "--json",
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");

  let parsed: Record<string, unknown>;
  expect(() => { parsed = JSON.parse(stdout); }).not.toThrow();
  parsed = JSON.parse(stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.id).toBe(t.id);
  expect(parsed.uuid).toBe(t.uuid);
  const changed = parsed.changed as Record<string, unknown>;
  expect(changed).toHaveProperty("effort", "high");
  // title was not set, so it must not appear
  expect(changed).not.toHaveProperty("title");
  // attendance was not set, so it must not appear
  expect(changed).not.toHaveProperty("attendance");
});
