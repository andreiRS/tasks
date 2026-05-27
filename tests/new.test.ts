import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, realpathSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

test("tasks new with no title exits non-zero with INVALID_TITLE and does not create store", async () => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "new"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir + "/..",
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_TITLE");

  // Validation must run before auto-init: no store dir should be created
  const projectsDir = join(tasksHome, "projects");
  expect(existsSync(projectsDir)).toBe(false);
});

test("tasks new with multi-line title exits non-zero with INVALID_TITLE and does not create store", async () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
  const proc = Bun.spawn(["bun", "run", cliPath, "new", "first line\nsecond line"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_TITLE");

  // Validation must run before auto-init: no projects dir created
  const projectsDir = join(tasksHome, "projects");
  expect(existsSync(projectsDir)).toBe(false);
});

test("tasks new with title exceeding 200 chars exits non-zero with INVALID_TITLE and does not create store", async () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
  const longTitle = "a".repeat(201);
  const proc = Bun.spawn(["bun", "run", cliPath, "new", longTitle], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_TITLE");

  // Validation must run before auto-init: no projects dir created
  const projectsDir = join(tasksHome, "projects");
  expect(existsSync(projectsDir)).toBe(false);
});

test("tasks new with exactly 200-char title succeeds (boundary)", async () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
  const boundaryTitle = "a".repeat(200);
  const proc = Bun.spawn(["bun", "run", cliPath, "new", boundaryTitle], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  expect(exitCode).toBe(0);
  expect(stdout).toContain("#1");

  // A task file should exist in backlog/
  const realCwdDir = realpathSync(cwdDir);
  const encodedCwd = realCwdDir.replace(/-/g, "--").replace(/\//g, "-");
  const storeDir = join(tasksHome, "projects", encodedCwd);
  const backlogFiles = readdirSync(join(storeDir, "backlog"));
  expect(backlogFiles).toHaveLength(1);
});

test("tasks new auto-initializes the store on first invocation", async () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
  const proc = Bun.spawn(["bun", "run", cliPath, "new", "hello"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  // exit code 0
  expect(exitCode).toBe(0);

  // Bun resolves symlinks in process.cwd(); do the same here so the path matches.
  // derive encoded path: literal `-` doubled to `--`, then `/` replaced with `-`
  const realCwdDir = realpathSync(cwdDir);
  const encodedCwd = realCwdDir.replace(/-/g, "--").replace(/\//g, "-");
  const storeDir = join(tasksHome, "projects", encodedCwd);

  // store directory exists
  expect(existsSync(storeDir)).toBe(true);

  // .git directory exists (it's a git repo)
  expect(existsSync(join(storeDir, ".git"))).toBe(true);

  // all six column directories exist
  for (const col of ["backlog", "ready", "doing", "blocked", "review", "done"]) {
    expect(existsSync(join(storeDir, col))).toBe(true);
  }

  // stderr contains auto-init notice
  expect(stderr).toContain("tasks: initialized store at");
});

test("tasks new writes task file, meta.yaml, and commits", async () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
  const proc = Bun.spawn(["bun", "run", cliPath, "new", "hello world"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  // exit code 0
  expect(exitCode).toBe(0);

  // stdout contains the short id (#1)
  expect(stdout).toContain("#1");

  const realCwdDir = realpathSync(cwdDir);
  const encodedCwd = realCwdDir.replace(/-/g, "--").replace(/\//g, "-");
  const storeDir = join(tasksHome, "projects", encodedCwd);

  // exactly one file in backlog/
  const backlogFiles = readdirSync(join(storeDir, "backlog"));
  expect(backlogFiles).toHaveLength(1);
  expect(backlogFiles[0]).toBe("1-hello-world.md");

  // parse the task file
  const taskContent = readFileSync(join(storeDir, "backlog", "1-hello-world.md"), "utf-8");

  // extract frontmatter between first and second ---
  const fmMatch = taskContent.match(/^---\n([\s\S]*?)\n---/);
  expect(fmMatch).not.toBeNull();
  const fm = parseYaml(fmMatch![1]) as Record<string, unknown>;

  expect(fm.id).toBe(1);
  expect(typeof fm.uuid).toBe("string");
  expect((fm.uuid as string)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(fm.title).toBe("hello world");
  expect(typeof fm.created_at).toBe("string");
  expect(typeof fm.updated_at).toBe("string");
  // both timestamps are ISO-8601
  expect(new Date(fm.created_at as string).toISOString()).toBe(fm.created_at as string);
  expect(new Date(fm.updated_at as string).toISOString()).toBe(fm.updated_at as string);
  // created_at and updated_at are equal for a fresh task
  expect(fm.created_at).toBe(fm.updated_at);

  // body after closing --- is empty/whitespace only
  const afterFm = taskContent.replace(/^---\n[\s\S]*?\n---\n?/, "");
  expect(afterFm.trim()).toBe("");

  // meta.yaml has next_id: 2
  const metaContent = readFileSync(join(storeDir, "meta.yaml"), "utf-8");
  const meta = parseYaml(metaContent) as Record<string, unknown>;
  expect(meta.next_id).toBe(2);

  // git log shows two commits: init + task: new #1
  const gitLog = Bun.spawnSync(["git", "log", "--oneline"], { cwd: storeDir });
  const logLines = new TextDecoder().decode(gitLog.stdout).trim().split("\n");
  expect(logLines).toHaveLength(2);
  // first line (most recent) starts with the task commit
  expect(logLines[0]).toMatch(/task: new #1/);
  // second line is init
  expect(logLines[1]).toMatch(/init/);

  // working tree is clean
  const gitStatus = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: storeDir });
  const statusOut = new TextDecoder().decode(gitStatus.stdout).trim();
  expect(statusOut).toBe("");
});

// ─── Dirty-tree guard tests ───────────────────────────────────────────────────

/**
 * Helper: derive the store directory path for cwdDir inside tasksHome.
 * Mirrors the encoding logic in store.ts: double `-`, then replace `/` with `-`.
 */
function getStoreDir(tasksHomeDir: string, cwdDirectory: string): string {
  const realCwd = realpathSync(cwdDirectory);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHomeDir, "projects", encoded);
}

test("tasks new refuses with STORE_DIRTY when store has staged uncommitted changes (plain-text mode)", async () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

  // Seed one task so the store is initialized and has at least one commit.
  const seedProc = Bun.spawn(["bun", "run", cliPath, "new", "seed task"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const seedExit = await seedProc.exited;
  if (seedExit !== 0) {
    const err = await new Response(seedProc.stderr).text();
    throw new Error(`seed failed (exit ${seedExit}): ${err}`);
  }

  const storeDir = getStoreDir(tasksHome, cwdDir);

  // Record current commit count.
  const logBefore = Bun.spawnSync(["git", "log", "--oneline"], { cwd: storeDir });
  const commitsBefore = new TextDecoder().decode(logBefore.stdout).trim().split("\n").length;

  // Dirty the working tree: write a file and stage it (staged = dirty).
  writeFileSync(join(storeDir, "dirty.txt"), "x\n", "utf-8");
  const addProc = Bun.spawnSync(["git", "-C", storeDir, "add", "dirty.txt"]);
  if (addProc.exitCode !== 0) {
    throw new Error("git add dirty.txt failed");
  }

  // Verify the tree really is dirty before the CLI call.
  const statusCheck = Bun.spawnSync(["git", "-C", storeDir, "status", "--porcelain"]);
  const statusOut = new TextDecoder().decode(statusCheck.stdout).trim();
  expect(statusOut).not.toBe("");

  // Now attempt tasks new: should fail with STORE_DIRTY.
  const proc = Bun.spawn(["bun", "run", cliPath, "new", "should be blocked"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("STORE_DIRTY");

  // No new commit should have been made.
  const logAfter = Bun.spawnSync(["git", "log", "--oneline"], { cwd: storeDir });
  const commitsAfter = new TextDecoder().decode(logAfter.stdout).trim().split("\n").length;
  expect(commitsAfter).toBe(commitsBefore);
});

test("tasks new refuses with STORE_DIRTY JSON envelope when store is dirty and --json is passed", async () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

  // Seed one task so the store is initialized.
  const seedProc = Bun.spawn(["bun", "run", cliPath, "new", "seed task"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const seedExit = await seedProc.exited;
  if (seedExit !== 0) {
    const err = await new Response(seedProc.stderr).text();
    throw new Error(`seed failed (exit ${seedExit}): ${err}`);
  }

  const storeDir = getStoreDir(tasksHome, cwdDir);

  // Dirty the working tree: write a file and stage it.
  writeFileSync(join(storeDir, "dirty2.txt"), "y\n", "utf-8");
  const addProc = Bun.spawnSync(["git", "-C", storeDir, "add", "dirty2.txt"]);
  if (addProc.exitCode !== 0) {
    throw new Error("git add dirty2.txt failed");
  }

  // Attempt tasks new --json: should fail with JSON envelope containing STORE_DIRTY.
  const proc = Bun.spawn(["bun", "run", cliPath, "new", "should be blocked", "--json"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode).not.toBe(0);

  // stderr should be a valid JSON error envelope.
  let parsed: Record<string, unknown>;
  expect(() => { parsed = JSON.parse(stderr); }).not.toThrow();
  parsed = JSON.parse(stderr);

  expect(parsed).toHaveProperty("error");
  const error = parsed.error as Record<string, unknown>;
  expect(error.code).toBe("STORE_DIRTY");
  expect(typeof error.message).toBe("string");
  expect(typeof error.details).toBe("object");
  expect(error.details).not.toBeNull();
});
