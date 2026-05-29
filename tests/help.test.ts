import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let tasksHome: string;
let cwdDir: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-help-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-help-cwd-"));
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

const ALL_COMMANDS = [
  "new", "show", "list", "board", "mv", "rm",
  "edit", "link", "unlink", "set", "next", "init", "undo", "help",
];

test("tasks --help: prints usage with every command, exits 0", async () => {
  const { exitCode, stdout } = await runCli(["--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Usage:");
  for (const cmd of ALL_COMMANDS) {
    expect(stdout).toContain(cmd);
  }
});

test("tasks --help: describes the tool and its human + agent audiences", async () => {
  const { exitCode, stdout } = await runCli(["--help"]);
  expect(exitCode).toBe(0);
  // A one-line framing precedes the command list so a first-time reader knows
  // what tasks is and why it serves both callers. Loose on wording, firm on intent.
  expect(stdout).toContain("humans");
  expect(stdout).toContain("agents");
  expect(stdout.indexOf("humans")).toBeLessThan(stdout.indexOf("Commands:"));
});

test("tasks -h: same as --help", async () => {
  const { exitCode, stdout } = await runCli(["-h"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Usage:");
  expect(stdout).toContain("new");
});

test("tasks help: subcommand form prints usage, exits 0", async () => {
  const { exitCode, stdout } = await runCli(["help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Usage:");
  for (const cmd of ALL_COMMANDS) {
    expect(stdout).toContain(cmd);
  }
});

test("tasks (no args): prints usage to stderr, exits 1", async () => {
  const { exitCode, stdout, stderr } = await runCli([]);
  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("Usage:");
});

test("tasks <unknown>: prints unknown-command error to stderr, exits 1", async () => {
  const { exitCode, stdout, stderr } = await runCli(["bogus"]);
  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("unknown command");
  expect(stderr).toContain("bogus");
  expect(stderr).toContain("Usage:");
});
