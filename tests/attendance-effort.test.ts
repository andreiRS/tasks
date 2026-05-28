import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
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
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-ae-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-ae-cwd-"));
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

function getStoreDir(): string {
  const real = realpathSync(cwdDir);
  const encoded = real.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

async function seedTask(title: string = "hello world"): Promise<void> {
  const { exitCode, stderr } = await runTasks(["new", title]);
  if (exitCode !== 0) {
    throw new Error(`seed failed (exit ${exitCode}): ${stderr}`);
  }
}

/**
 * Read frontmatter of the single task file in `<col>` directory and return parsed yaml.
 */
function readSingleTaskFm(col: string): Record<string, unknown> {
  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, col)).filter((f) => f.endsWith(".md"));
  expect(files).toHaveLength(1);
  const raw = readFileSync(join(storeDir, col, files[0]), "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  expect(fmMatch).not.toBeNull();
  return parseYaml(fmMatch![1]) as Record<string, unknown>;
}

// ─── Defaults written to disk by `tasks new` ────────────────────────────────

test("tasks new writes attendance=attended and effort=medium to disk frontmatter", async () => {
  await seedTask("first task");

  const fm = readSingleTaskFm("backlog");
  expect(fm.attendance).toBe("attended");
  expect(fm.effort).toBe("medium");
});

// ─── show --json surfaces defaults ──────────────────────────────────────────

test("tasks show --json emits attendance and effort with defaults for a fresh task", async () => {
  await seedTask("a task");

  const { exitCode, stdout } = await runTasks(["show", "1", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(parsed.attendance).toBe("attended");
  expect(parsed.effort).toBe("medium");
});

// ─── Legacy frontmatter (missing fields) resolves to defaults on read ───────

test("legacy task file without attendance/effort surfaces defaults via show --json and list --json", async () => {
  await seedTask("legacy task");

  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, "backlog")).filter((f) => f.endsWith(".md"));
  expect(files).toHaveLength(1);
  const filePath = join(storeDir, "backlog", files[0]);
  const raw = readFileSync(filePath, "utf-8");

  // Strip any attendance/effort lines if present (defensive; even though the
  // green code will have written them, this hand-edits the file back to the
  // legacy shape).
  const stripped = raw
    .replace(/^attendance:.*\n/m, "")
    .replace(/^effort:.*\n/m, "");
  writeFileSync(filePath, stripped, "utf-8");

  // Re-commit the hand-edit so the store is clean for subsequent reads. We
  // bypass the dirty-tree guard because reads don't run it.
  Bun.spawnSync(["git", "-C", storeDir, "add", "-A"]);
  Bun.spawnSync(["git", "-C", storeDir, "commit", "-m", "test: strip enum fields"]);

  // Sanity: file really lacks attendance/effort now.
  const fmRaw = readFileSync(filePath, "utf-8");
  expect(/^attendance:/m.test(fmRaw)).toBe(false);
  expect(/^effort:/m.test(fmRaw)).toBe(false);

  // show --json must resolve to defaults
  const showRes = await runTasks(["show", "1", "--json"]);
  expect(showRes.exitCode).toBe(0);
  const showParsed = JSON.parse(showRes.stdout) as Record<string, unknown>;
  expect(showParsed.attendance).toBe("attended");
  expect(showParsed.effort).toBe("medium");

  // list --json must resolve to defaults too
  const listRes = await runTasks(["list", "--json"]);
  expect(listRes.exitCode).toBe(0);
  const listParsed = JSON.parse(listRes.stdout) as Array<Record<string, unknown>>;
  expect(listParsed).toHaveLength(1);
  expect(listParsed[0].attendance).toBe("attended");
  expect(listParsed[0].effort).toBe("medium");
});

// ─── Validator rejects invalid attendance on mutating command ───────────────

test("mutating command (mv) refuses with INVALID_ATTENDANCE when a task on disk has a bogus attendance value", async () => {
  await seedTask("first");
  await seedTask("second");

  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, "backlog"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  // Corrupt the first file: replace attendance value with garbage.
  const filePath = join(storeDir, "backlog", files[0]);
  const raw = readFileSync(filePath, "utf-8");
  const bad = raw.replace(/^attendance:.*$/m, "attendance: bogus");
  writeFileSync(filePath, bad, "utf-8");
  Bun.spawnSync(["git", "-C", storeDir, "add", "-A"]);
  Bun.spawnSync(["git", "-C", storeDir, "commit", "-m", "test: corrupt attendance"]);

  // Now try to mv the (other) task. The validator must reject because the
  // store contains a task with an invalid attendance value.
  const { exitCode, stderr } = await runTasks(["mv", "2", "ready", "--json"]);

  expect(exitCode).not.toBe(0);
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  expect(parsed).toHaveProperty("error");
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("INVALID_ATTENDANCE");
  expect(typeof err.message).toBe("string");
  expect(typeof err.details).toBe("object");
});

// ─── Validator rejects invalid effort on mutating command ───────────────────

test("mutating command (mv) refuses with INVALID_EFFORT when a task on disk has a bogus effort value", async () => {
  await seedTask("first");
  await seedTask("second");

  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, "backlog"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  const filePath = join(storeDir, "backlog", files[0]);
  const raw = readFileSync(filePath, "utf-8");
  const bad = raw.replace(/^effort:.*$/m, "effort: gargantuan");
  writeFileSync(filePath, bad, "utf-8");
  Bun.spawnSync(["git", "-C", storeDir, "add", "-A"]);
  Bun.spawnSync(["git", "-C", storeDir, "commit", "-m", "test: corrupt effort"]);

  const { exitCode, stderr } = await runTasks(["mv", "2", "ready", "--json"]);

  expect(exitCode).not.toBe(0);
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  expect(parsed).toHaveProperty("error");
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("INVALID_EFFORT");
  expect(typeof err.message).toBe("string");
  expect(typeof err.details).toBe("object");
});
