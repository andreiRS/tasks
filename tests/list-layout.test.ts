import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-list-layout-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-list-layout-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

async function runTasks(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    env: { ...process.env, TASKS_HOME: tasksHome, ...env },
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

// ─── The 10-task example from the spec, rendered byte-for-byte ────────────────

test("tasks list renders the spec's 10-task example layout exactly", async () => {
  // #1 doing — Design auth API surface
  await runTasks(["new", "Design auth API surface"]);
  // #2 backlog (blocked by #1) — Implement JWT signing helper
  await runTasks(["new", "Implement JWT signing helper", "--deps", "1"]);
  // #3 backlog (blocked by #1, #2) — Wire login endpoint
  await runTasks(["new", "Wire login endpoint", "--deps", "1", "--deps", "2"]);
  // #4 backlog [auto] (blocked by #3) — Add refresh token rotation
  await runTasks(["new", "Add refresh token rotation", "--unattended", "--deps", "3"]);
  // #5 doing — Migrate users table to v2
  await runTasks(["new", "Migrate users table to v2"]);
  // #6 backlog [auto] (blocked by #5) — Backfill missing email_verified flag
  await runTasks(["new", "Backfill missing email_verified flag", "--unattended", "--deps", "5"]);
  // #7 backlog (blocked by #3, #4) — Write integration tests for auth
  await runTasks(["new", "Write integration tests for auth", "--deps", "3", "--deps", "4"]);
  // #8 backlog (blocked by #7) — Document auth flow in README
  await runTasks(["new", "Document auth flow in README", "--deps", "7"]);
  // #9 review [auto] — Audit npm deps for CVEs
  await runTasks(["new", "Audit npm deps for CVEs", "--unattended"]);
  // #10 done — Ship v1.2 release notes
  await runTasks(["new", "Ship v1.2 release notes"]);

  // Move into target columns.
  await runTasks(["mv", "1", "doing"]);
  await runTasks(["mv", "5", "doing"]);
  await runTasks(["mv", "9", "review"]);
  await runTasks(["mv", "10", "done"]);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  const expected =
    "#1   doing            Design auth API surface" + "\n" +
    "#5   doing            Migrate users table to v2" + "\n" +
    "#9   review   [auto]  Audit npm deps for CVEs" + "\n" +
    "#10  done             Ship v1.2 release notes" + "\n" +
    "#2   backlog          Implement JWT signing helper" + " ".repeat(58) + "← #1" + "\n" +
    "#3   backlog          Wire login endpoint" + " ".repeat(67) + "← #1, #2" + "\n" +
    "#4   backlog  [auto]  Add refresh token rotation" + " ".repeat(60) + "← #3" + "\n" +
    "#6   backlog  [auto]  Backfill missing email_verified flag" + " ".repeat(50) + "← #5" + "\n" +
    "#7   backlog          Write integration tests for auth" + " ".repeat(54) + "← #3, #4" + "\n" +
    "#8   backlog          Document auth flow in README" + " ".repeat(58) + "← #7" + "\n";

  expect(stdout).toBe(expected);
});

// ─── Arrows pin at the fixed tab stop (column 108 for this set) ───────────────

test("tasks list aligns dependency arrows at a fixed tab stop", async () => {
  await runTasks(["new", "Design auth API surface"]);
  await runTasks(["new", "Implement JWT signing helper", "--deps", "1"]);
  await runTasks(["new", "Add refresh token rotation", "--unattended", "--deps", "1"]);
  await runTasks(["mv", "1", "doing"]);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n").filter((l) => l.length > 0);
  const arrowLines = lines.filter((l) => l.includes("←"));
  expect(arrowLines.length).toBe(2);
  // All arrows begin at the same column. idW=2 (#1..#3), gutter present:
  // prefix = 2 + 2 + 7 + 2 + 6 + 2 = 21, titleW = 120-21-2-12 = 85, tab = 108.
  for (const l of arrowLines) {
    expect(l.indexOf("←")).toBe(108);
  }
});

// ─── No arrow on rows whose deps are all complete / absent ────────────────────

test("tasks list shows no arrow when a task has no unmet blockers", async () => {
  await runTasks(["new", "standalone task"]);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("←");
});

// ─── Long title truncates with an ellipsis ────────────────────────────────────

test("tasks list truncates an over-long title with a trailing ellipsis", async () => {
  // titleW with no unattended task, idW=2: prefix = 2+2+7+2 = 13,
  // titleW = max(10, 120-13-2-12) = 93.
  const longTitle = "x".repeat(200);
  await runTasks(["new", longTitle]);

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  const line = stdout.split("\n").find((l) => l.includes("x"))!;
  // Title field is exactly 93 wide: 92 x's then the ellipsis.
  const titleField = line.slice(13);
  expect(titleField).toBe("x".repeat(92) + "…");
  expect(titleField.length).toBe(93);
});

// ─── Many-blocker list truncates with a +N suffix ─────────────────────────────

test("tasks list truncates a long blocker list with a +N suffix", async () => {
  // Six upstream tasks (#1..#6), all in doing (incomplete), then a backlog
  // task depending on all six. The 12-col arrow tail cannot hold all ids.
  for (let i = 1; i <= 6; i++) {
    await runTasks(["new", `upstream ${i}`]);
  }
  await runTasks([
    "new", "downstream",
    "--deps", "1", "--deps", "2", "--deps", "3",
    "--deps", "4", "--deps", "5", "--deps", "6",
  ]);
  for (let i = 1; i <= 6; i++) {
    await runTasks(["mv", String(i), "doing"]);
  }

  const { exitCode, stdout } = await runTasks(["list"], { NO_COLOR: "1" });
  expect(exitCode).toBe(0);

  const line = stdout.split("\n").find((l) => l.includes("downstream"))!;
  // Tail is 12 cols. "← #1, #2 +4" fits (11 chars), "← #1, #2, #3 +3" is 15
  // chars and overflows, so 2 ids shown, +4 hidden.
  const tail = line.slice(line.indexOf("←"));
  expect(tail).toBe("← #1, #2 +4");
});
