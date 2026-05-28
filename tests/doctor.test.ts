import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let tasksHome: string;
let projRoot: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-doctor-home-"));
  projRoot = mkdtempSync(join(tmpdir(), "tasks-doctor-proj-"));
  // Mark this as a project root so the store key resolves stably.
  mkdirSync(join(projRoot, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(projRoot, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  cwd: string = projRoot,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

/** Find the unique store dir under TASKS_HOME/projects (asserts exactly one). */
function storePath(): string {
  const projectsDir = join(tasksHome, "projects");
  const dirs = readdirSync(projectsDir);
  expect(dirs).toHaveLength(1);
  return join(projectsDir, dirs[0]);
}

test("tasks doctor: on a clean store prints store path, empty status, stashes: 0, exits 0", async () => {
  // Initialize the store via `tasks init` so we have a clean tree.
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);

  const store = storePath();

  const { exitCode, stdout } = await runCli(["doctor"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain(store);
  expect(stdout).toContain("stashes: 0");
  // Status section is present but empty (no porcelain lines).
  // We do not assert the exact label text; only that no obvious dirty markers appear.
  expect(stdout).not.toMatch(/^\?\?/m);
  expect(stdout).not.toMatch(/^ M/m);
});

test("tasks doctor: on a dirty store (untracked file) the status includes the file, exit 0", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);

  const store = storePath();
  // Drop an untracked file directly in the store (not in any column dir).
  writeFileSync(join(store, "stray.md"), "hi\n", "utf-8");

  const { exitCode, stdout } = await runCli(["doctor"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain(store);
  expect(stdout).toContain("stray.md");
  expect(stdout).toContain("stashes: 0");
});

test("tasks doctor: reports stash count after N prior stashes, exit 0", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);

  const store = storePath();

  // Create two stashes by hand inside the store, with an untracked file each.
  for (let i = 0; i < 2; i++) {
    writeFileSync(join(store, `stray-${i}.md`), `${i}\n`, "utf-8");
    const proc = Bun.spawn(
      ["git", "-C", store, "stash", "push", "--include-untracked", "-m", `pre-${i}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    expect(code).toBe(0);
  }

  const { exitCode, stdout } = await runCli(["doctor"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("stashes: 2");
});

test("tasks doctor: does not auto-create a missing store; exits 0 with a sensible report", async () => {
  // No init, no store on disk for this project.
  const projectsDir = join(tasksHome, "projects");

  const { exitCode, stdout } = await runCli(["doctor"]);
  expect(exitCode).toBe(0);
  // Should print *some* output (a report), not crash.
  expect(stdout.length).toBeGreaterThan(0);
  // Critically: the store directory must not have been created.
  if (existsSync(projectsDir)) {
    expect(readdirSync(projectsDir)).toHaveLength(0);
  }
});

test("tasks --help: lists `doctor`", async () => {
  const { exitCode, stdout } = await runCli(["--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("doctor");
});
