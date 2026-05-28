import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
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

async function git(store: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", "-C", store, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  return { code, stdout };
}

test("tasks doctor --clean: untracked stray is stashed, tree clean, ref + path printed, exit 0", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);

  const store = storePath();
  writeFileSync(join(store, "stray.md"), "stray-content\n", "utf-8");

  const { exitCode, stdout } = await runCli(["doctor", "--clean"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("stash@{0}");
  expect(stdout).toContain(store);

  // Tree is now clean.
  const status = await git(store, ["status", "--short"]);
  expect(status.stdout.trim()).toBe("");

  // Stray is recoverable via stash pop.
  const pop = await git(store, ["stash", "pop"]);
  expect(pop.code).toBe(0);
  expect(existsSync(join(store, "stray.md"))).toBe(true);
  expect(readFileSync(join(store, "stray.md"), "utf-8")).toBe("stray-content\n");
});

test("tasks doctor --clean: modified tracked file is stashed (restored to HEAD), recoverable", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);
  // Create a task so we have a tracked file to modify.
  const created = await runCli(["new", "trackme"]);
  expect(created.exitCode).toBe(0);

  const store = storePath();
  // Find a tracked .md file under the store and modify it.
  const lsFiles = await git(store, ["ls-files"]);
  const tracked = lsFiles.stdout.split("\n").filter((l) => l.endsWith(".md"))[0];
  expect(tracked).toBeTruthy();
  const trackedPath = join(store, tracked);
  const original = readFileSync(trackedPath, "utf-8");
  writeFileSync(trackedPath, original + "\nLOCAL EDIT\n", "utf-8");

  const { exitCode, stdout } = await runCli(["doctor", "--clean"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("stash@{0}");

  // File restored to HEAD content.
  expect(readFileSync(trackedPath, "utf-8")).toBe(original);
  const status = await git(store, ["status", "--short"]);
  expect(status.stdout.trim()).toBe("");

  // Recoverable.
  const pop = await git(store, ["stash", "pop"]);
  expect(pop.code).toBe(0);
  expect(readFileSync(trackedPath, "utf-8")).toBe(original + "\nLOCAL EDIT\n");
});

test("tasks doctor --clean: mix of modified + untracked + classic editor strays captured in one stash", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);
  const created = await runCli(["new", "mix"]);
  expect(created.exitCode).toBe(0);

  const store = storePath();
  const lsFiles = await git(store, ["ls-files"]);
  const tracked = lsFiles.stdout.split("\n").filter((l) => l.endsWith(".md"))[0];
  const trackedPath = join(store, tracked);
  const original = readFileSync(trackedPath, "utf-8");
  writeFileSync(trackedPath, original + "\nedit\n", "utf-8");
  writeFileSync(join(store, "stray.md"), "stray\n", "utf-8");
  writeFileSync(join(store, "draft.md.swp"), "swap\n", "utf-8");

  const stashesBefore = await git(store, ["stash", "list"]);
  const beforeCount = stashesBefore.stdout.split("\n").filter((l) => l.length > 0).length;

  const { exitCode } = await runCli(["doctor", "--clean"]);
  expect(exitCode).toBe(0);

  const stashesAfter = await git(store, ["stash", "list"]);
  const afterCount = stashesAfter.stdout.split("\n").filter((l) => l.length > 0).length;
  expect(afterCount).toBe(beforeCount + 1);

  const status = await git(store, ["status", "--short"]);
  expect(status.stdout.trim()).toBe("");

  // One stash pop restores all three.
  const pop = await git(store, ["stash", "pop"]);
  expect(pop.code).toBe(0);
  expect(readFileSync(trackedPath, "utf-8")).toBe(original + "\nedit\n");
  expect(existsSync(join(store, "stray.md"))).toBe(true);
  expect(existsSync(join(store, "draft.md.swp"))).toBe(true);
});

test("tasks doctor --clean: already-clean store prints 'store already clean', no stash, exit 0", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);

  const store = storePath();
  const before = await git(store, ["stash", "list"]);
  const beforeCount = before.stdout.split("\n").filter((l) => l.length > 0).length;

  const { exitCode, stdout } = await runCli(["doctor", "--clean"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("store already clean");

  const after = await git(store, ["stash", "list"]);
  const afterCount = after.stdout.split("\n").filter((l) => l.length > 0).length;
  expect(afterCount).toBe(beforeCount);
});

test("tasks doctor --clean: after clearing dirty tree, follow-up `tasks new` succeeds (no STORE_DIRTY)", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);

  const store = storePath();
  writeFileSync(join(store, "stray.md"), "stray\n", "utf-8");

  // Sanity: mutating command refuses while dirty.
  const dirtyNew = await runCli(["new", "blocked"]);
  expect(dirtyNew.exitCode).not.toBe(0);
  expect(dirtyNew.stderr).toContain("STORE_DIRTY");

  const clean = await runCli(["doctor", "--clean"]);
  expect(clean.exitCode).toBe(0);

  const followUp = await runCli(["new", "after-clean"]);
  expect(followUp.exitCode).toBe(0);
  expect(followUp.stderr).not.toContain("STORE_DIRTY");
});

test("tasks --help: lists `doctor`", async () => {
  const { exitCode, stdout } = await runCli(["--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("doctor");
});

test("tasks doctor --json: clean store returns { store, status: [], stashes: 0 }, exit 0", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);
  const store = storePath();

  const { exitCode, stdout } = await runCli(["doctor", "--json"]);
  expect(exitCode).toBe(0);
  const data = JSON.parse(stdout);
  expect(data).toEqual({ store, status: [], stashes: 0 });
});

test("tasks doctor --json: parses porcelain codes verbatim into { code, path } entries", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);
  const store = storePath();

  // Create a tracked file first (mutating commands need a clean tree).
  const created = await runCli(["new", "trackme"]);
  expect(created.exitCode).toBe(0);
  const lsFiles = await git(store, ["ls-files"]);
  const tracked = lsFiles.stdout.split("\n").filter((l) => l.endsWith(".md"))[0];
  const trackedPath = join(store, tracked);

  // Modified tracked file => code " M"
  writeFileSync(trackedPath, readFileSync(trackedPath, "utf-8") + "\nedit\n", "utf-8");
  // Untracked stray => code "??"
  writeFileSync(join(store, "stray.md"), "x\n", "utf-8");

  const { exitCode, stdout } = await runCli(["doctor", "--json"]);
  expect(exitCode).toBe(0);
  const data = JSON.parse(stdout);
  expect(data.store).toBe(store);
  expect(data.stashes).toBe(0);
  expect(Array.isArray(data.status)).toBe(true);

  const stray = data.status.find((e: { code: string; path: string }) => e.path === "stray.md");
  expect(stray).toBeDefined();
  expect(stray.code).toBe("??");

  const mod = data.status.find((e: { code: string; path: string }) => e.path === tracked);
  expect(mod).toBeDefined();
  expect(mod.code).toBe(" M");
});

test("tasks doctor --clean --json: dirty tree returns { store, stashed: true, stash_ref }, tree clean", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);
  const store = storePath();
  writeFileSync(join(store, "stray.md"), "x\n", "utf-8");

  const { exitCode, stdout } = await runCli(["doctor", "--clean", "--json"]);
  expect(exitCode).toBe(0);
  const data = JSON.parse(stdout);
  expect(data).toEqual({ store, stashed: true, stash_ref: "stash@{0}" });

  const status = await git(store, ["status", "--short"]);
  expect(status.stdout.trim()).toBe("");
});

test("tasks doctor --clean --json: already-clean tree returns { stashed: false, already_clean: true }, no new stash", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);
  const store = storePath();

  const before = await git(store, ["stash", "list"]);
  const beforeCount = before.stdout.split("\n").filter((l) => l.length > 0).length;

  const { exitCode, stdout } = await runCli(["doctor", "--clean", "--json"]);
  expect(exitCode).toBe(0);
  const data = JSON.parse(stdout);
  expect(data).toEqual({ store, stashed: false, already_clean: true });

  const after = await git(store, ["stash", "list"]);
  const afterCount = after.stdout.split("\n").filter((l) => l.length > 0).length;
  expect(afterCount).toBe(beforeCount);
});

test("tasks doctor: piped (non-TTY) without --json still prints human output, not JSON", async () => {
  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);

  // runCli already uses piped stdout (non-TTY). Output must remain human.
  const { exitCode, stdout } = await runCli(["doctor"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("store:");
  expect(stdout).toContain("stashes: 0");
  // Not JSON.
  expect(() => JSON.parse(stdout)).toThrow();
});
