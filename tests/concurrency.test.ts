import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, realpathSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

let tasksHome: string;
let cwdDir: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-cwd-"));
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

function storePath(): string {
  const realCwdDir = realpathSync(cwdDir);
  const encodedCwd = realCwdDir.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encodedCwd);
}

function cliPath(): string {
  return join(import.meta.dir, "..", "src", "cli.ts");
}

async function runNew(title: string): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cliPath(), "new", title], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const exit = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exit, stdout, stderr };
}

test("two concurrent `tasks new` invocations serialize and produce distinct ids", async () => {
  // Pre-init the store synchronously by creating the seed task. This avoids a
  // concurrent `git init` race, which is a separate concern.
  const seed = await runNew("seed");
  expect(seed.exit).toBe(0);

  const storeDir = storePath();
  expect(existsSync(join(storeDir, ".tasks-lock"))).toBe(true);

  // Now fire two `tasks new` in parallel.
  const [a, b] = await Promise.all([runNew("alpha"), runNew("bravo")]);
  expect(a.exit).toBe(0);
  expect(b.exit).toBe(0);

  // meta.yaml should reflect next_id: 4 (seed=1, alpha/bravo = 2 and 3)
  const meta = parseYaml(readFileSync(join(storeDir, "meta.yaml"), "utf-8")) as { next_id: number };
  expect(meta.next_id).toBe(4);

  // backlog/ should contain exactly three files
  const backlog = readdirSync(join(storeDir, "backlog")).filter((f) => f.endsWith(".md"));
  expect(backlog.length).toBe(3);

  // Collect the ids from each task file's frontmatter and ensure they are {1,2,3}
  const ids = new Set<number>();
  for (const file of backlog) {
    const raw = readFileSync(join(storeDir, "backlog", file), "utf-8");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const fm = parseYaml(fmMatch![1]) as { id: number };
    ids.add(fm.id);
  }
  expect(ids).toEqual(new Set([1, 2, 3]));

  // git log should have exactly 4 commits: init + 3 task: new
  const proc = Bun.spawn(["git", "-C", storeDir, "log", "--oneline"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const log = await new Response(proc.stdout).text();
  const lines = log.trim().split("\n").filter((l) => l.length > 0);
  expect(lines.length).toBe(4);
});

test("lock file is created at <store>/.tasks-lock after a mutation", async () => {
  const r = await runNew("only");
  expect(r.exit).toBe(0);
  const storeDir = storePath();
  expect(existsSync(join(storeDir, ".tasks-lock"))).toBe(true);
});

// TODO: assert that read commands (`tasks show`) do not block on the lock.
// Deferred — needs a clean way to inject a delay into the lock-held critical
// section (e.g. an env-var sleep hook).
