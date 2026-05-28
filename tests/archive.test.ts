import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-archive-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-archive-cwd-"));
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

async function gitLogSubject(storeDir: string): Promise<string> {
  const gitBin = Bun.which("git") ?? "/opt/homebrew/bin/git";
  const proc = Bun.spawn([gitBin, "log", "-1", "--pretty=%s"], {
    cwd: storeDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

async function plantDoneTask(title: string): Promise<number> {
  const before = await runTasks(["list", "--json"]);
  const beforeCount = before.exitCode === 0 && before.stdout.trim()
    ? (JSON.parse(before.stdout).tasks?.length ?? 0)
    : 0;
  const create = await runTasks(["new", title]);
  if (create.exitCode !== 0) throw new Error(`new failed: ${create.stderr}`);
  // Short id is monotonic; figure it out by parsing stdout `#N`.
  const m = create.stdout.match(/#(\d+)/);
  if (!m) throw new Error(`could not parse id from: ${create.stdout}`);
  const id = parseInt(m[1], 10);
  const mv = await runTasks(["mv", String(id), "done"]);
  if (mv.exitCode !== 0) throw new Error(`mv failed: ${mv.stderr}`);
  void beforeCount;
  return id;
}

test("tasks archive: with no flags, moves every done/ task into archive/ in a single commit", async () => {
  const id1 = await plantDoneTask("first done");
  const id2 = await plantDoneTask("second done");

  const storeDir = deriveStoreDir();
  expect(readdirSync(join(storeDir, "done")).filter((f) => f.endsWith(".md")).length).toBe(2);
  expect(readdirSync(join(storeDir, "archive")).filter((f) => f.endsWith(".md")).length).toBe(0);

  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["archive"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);

  expect(readdirSync(join(storeDir, "done")).filter((f) => f.endsWith(".md")).length).toBe(0);
  expect(readdirSync(join(storeDir, "archive")).filter((f) => f.endsWith(".md")).length).toBe(2);

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore + 1);

  const subject = await gitLogSubject(storeDir);
  expect(subject).toContain("archive");
  void id1; void id2;
});

test("tasks archive <id>: archives only that task; rejects with INVALID_COLUMN when task is not in done/", async () => {
  const doneId = await plantDoneTask("ready to retire");
  const newer = await runTasks(["new", "still working"]);
  expect(newer.exitCode).toBe(0);
  const newerId = parseInt(newer.stdout.match(/#(\d+)/)![1], 10);

  const storeDir = deriveStoreDir();

  // Single-task form: success path on the done/ task.
  const ok = await runTasks(["archive", String(doneId)]);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout).toContain(`archived #${doneId}`);
  expect(readdirSync(join(storeDir, "done")).filter((f) => f.endsWith(".md")).length).toBe(0);
  expect(readdirSync(join(storeDir, "archive")).filter((f) => f.endsWith(".md")).length).toBe(1);

  // Rejection path: archiving a backlog/ task fails with INVALID_COLUMN.
  const bad = await runTasks(["archive", String(newerId)]);
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr).toContain("INVALID_COLUMN");
  expect(readdirSync(join(storeDir, "backlog")).filter((f) => f.endsWith(".md")).length).toBe(1);
});

test("tasks archive --before <duration>: only archives done/ tasks older than the cutoff", async () => {
  // Plant two done tasks; backdate the first's updated_at to 60 days ago.
  const oldId = await plantDoneTask("ancient history");
  const recentId = await plantDoneTask("just finished");

  const storeDir = deriveStoreDir();
  const doneDir = join(storeDir, "done");
  const files = readdirSync(doneDir).filter((f) => f.endsWith(".md"));
  const oldFile = files.find((f) => f.startsWith(`${oldId}-`))!;
  const oldPath = join(doneDir, oldFile);
  const raw = require("node:fs").readFileSync(oldPath, "utf-8");
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  require("node:fs").writeFileSync(
    oldPath,
    raw.replace(/^updated_at:.*$/m, `updated_at: ${sixtyDaysAgo}`),
    "utf-8",
  );
  // Commit the backdate so the tree is clean before archive runs.
  const gitBin = Bun.which("git") ?? "/opt/homebrew/bin/git";
  await Bun.spawn([gitBin, "commit", "-am", "test: backdate"], { cwd: storeDir }).exited;

  const { exitCode, stdout } = await runTasks(["archive", "--before", "30d"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`#${oldId}`);
  expect(stdout).not.toContain(`#${recentId}`);

  expect(readdirSync(join(storeDir, "done")).filter((f) => f.endsWith(".md")).length).toBe(1);
  expect(readdirSync(join(storeDir, "archive")).filter((f) => f.endsWith(".md")).length).toBe(1);
});

test("tasks archive: with no done/ tasks, exits 0 with no commit and a stderr notice", async () => {
  // Create the store (auto-init) but leave done/ empty.
  await runTasks(["new", "in backlog"]);
  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["archive"]);
  expect(exitCode).toBe(0);
  expect(stderr).toContain("nothing to archive");

  const commitsAfter = await gitLogCount(storeDir);
  expect(commitsAfter).toBe(commitsBefore);
  expect(existsSync(join(storeDir, "archive"))).toBe(true);
});
