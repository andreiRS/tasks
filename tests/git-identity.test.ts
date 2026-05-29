import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let tasksHome: string;
let cwdDir: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-ident-home-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-ident-cwd-"));
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

const IDENTITY_VARS = [
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL",
];

/**
 * Build a CLI environment pointed at a custom global gitconfig with the system
 * config nulled and all GIT_*_NAME/EMAIL vars stripped, so git's only possible
 * identity comes from the file we write. Mirrors a fresh CI runner / container.
 */
function envWithGitconfig(contents: string): Record<string, string> {
  const gitconfig = join(cwdDir, "test.gitconfig");
  writeFileSync(gitconfig, contents, "utf-8");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TASKS_HOME: tasksHome,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  for (const k of IDENTITY_VARS) delete env[k];
  return env;
}

// useConfigOnly blocks git's gecos/hostname auto-detection, so with no
// user.name/email set there is genuinely no identity available.
const NO_IDENTITY = "[user]\n\tuseConfigOnly = true\n";

async function run(env: Record<string, string>, args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env, cwd: cwdDir, stdout: "pipe", stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

async function committerOf(env: Record<string, string>): Promise<string> {
  const doctor = await run(env, ["doctor", "--json"]);
  const store = JSON.parse(doctor.stdout).store as string;
  const log = Bun.spawn(["git", "-C", store, "log", "-1", "--format=%cn <%ce>"], {
    env, stdout: "pipe", stderr: "pipe",
  });
  await log.exited;
  return (await new Response(log.stdout).text()).trim();
}

test("mutations succeed when git has no configured identity (CI / container)", async () => {
  const env = envWithGitconfig(NO_IDENTITY);

  const first = await run(env, ["new", "first task"]);
  expect(first.exitCode).toBe(0);

  // If the first mutation's commit were silently dropped, the working tree
  // would be left dirty and this second mutation would fail STORE_DIRTY.
  const second = await run(env, ["new", "second task"]);
  expect(second.exitCode).toBe(0);

  const list = await run(env, ["list", "--json"]);
  expect(list.exitCode).toBe(0);
  expect(JSON.parse(list.stdout)).toHaveLength(2);

  // undo runs `git revert`, which also needs an identity to commit.
  const undo = await run(env, ["undo"]);
  expect(undo.exitCode).toBe(0);
});

test("commits use a built-in identity when none is configured", async () => {
  const env = envWithGitconfig(NO_IDENTITY);
  expect((await run(env, ["new", "a task"])).exitCode).toBe(0);
  expect(await committerOf(env)).toBe("tasks <tasks@localhost>");
});

test("commits keep the user's configured identity when present", async () => {
  const env = envWithGitconfig(
    "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n"
  );
  expect((await run(env, ["new", "a task"])).exitCode).toBe(0);
  expect(await committerOf(env)).toBe("Ada Lovelace <ada@example.com>");
});
