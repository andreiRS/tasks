import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-test-flock-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-cwd-flock-"));
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

function cliPath(): string {
  return join(import.meta.dir, "..", "src", "cli.ts");
}

// Use the absolute bun path so PATH=/nonexistent doesn't break the spawn.
const BUN_BIN = process.execPath; // absolute path to the running bun binary

async function runNewNoFlock(
  title: string,
  extraArgs: string[] = []
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [BUN_BIN, "run", cliPath(), "new", title, ...extraArgs],
    {
      env: { ...process.env, PATH: "/nonexistent", TASKS_HOME: tasksHome },
      stdout: "pipe",
      stderr: "pipe",
      cwd: cwdDir,
    }
  );
  const exit = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exit, stdout, stderr };
}

test("tasks new with flock missing exits non-zero", async () => {
  const r = await runNewNoFlock("hello");
  expect(r.exit).not.toBe(0);
});

test("tasks new with flock missing writes actionable plain-text error to stderr", async () => {
  const r = await runNewNoFlock("hello");
  expect(r.stderr).toContain("flock");
  expect(r.stderr).toContain("brew install flock");
});

test("tasks new --json with flock missing writes FLOCK_MISSING JSON envelope to stderr", async () => {
  const r = await runNewNoFlock("hello", ["--json"]);
  expect(r.exit).not.toBe(0);

  let parsed: { error: { code: string; message: string; details: unknown } };
  try {
    parsed = JSON.parse(r.stderr.trim());
  } catch {
    throw new Error(`stderr was not valid JSON:\n${r.stderr}`);
  }

  expect(parsed.error.code).toBe("FLOCK_MISSING");
  expect(typeof parsed.error.message).toBe("string");
  expect(parsed.error.message.length).toBeGreaterThan(0);
});
