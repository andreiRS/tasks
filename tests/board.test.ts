import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS } from "../src/store.ts";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

/**
 * Pinned wall clock for these fixtures. Planted tasks are stamped with this
 * exact time, and the CLI's TASKS_NOW is pinned to it too, so the done-window
 * cutoff math is deterministic regardless of the real date.
 */
const PINNED_NOW = "2026-05-27T10:00:00.000Z";

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-board-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-board-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

async function runTasks(args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    env: { ...process.env, TASKS_HOME: tasksHome, TASKS_NOW: PINNED_NOW, ...env },
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

/** Deterministic UUID for a short id (matches the seed convention). */
function depUuid(id: number): string {
  return `${"a".repeat(8)}-${id.toString().padStart(4, "0")}-4000-8000-${"b".repeat(12)}`;
}

interface PlantOpts {
  /** Short ids this task depends on (mapped to deterministic UUIDs). */
  deps?: number[];
  attendance?: "attended" | "unattended";
}

/**
 * Manually plant a task file into a given column directory.
 */
function plantTask(storeDir: string, column: string, id: number, title: string, opts: PlantOpts = {}): void {
  const colDir = join(storeDir, column);
  mkdirSync(colDir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filename = `${id}-${slug}.md`;
  const now = PINNED_NOW;
  const uuid = depUuid(id);
  const deps = opts.deps ?? [];
  const depsYaml = deps.length === 0 ? "[]" : `[${deps.map((d) => `"${depUuid(d)}"`).join(", ")}]`;
  const attendance = opts.attendance ?? "attended";
  const content =
    `---\nid: ${id}\nuuid: ${uuid}\ntitle: ${title}\ndeps: ${depsYaml}\n` +
    `attendance: ${attendance}\neffort: medium\ncreated_at: ${now}\nupdated_at: ${now}\n---\n`;
  writeFileSync(join(colDir, filename), content, "utf-8");
}

/**
 * Initialize a bare store without going through the CLI.
 */
async function initBareStore(storeDir: string): Promise<void> {
  mkdirSync(storeDir, { recursive: true });
  for (const col of COLUMNS) {
    mkdirSync(join(storeDir, col), { recursive: true });
  }
  const spawn = (args: string[]) =>
    Bun.spawn(args, { cwd: storeDir, stdout: "pipe", stderr: "pipe" }).exited;
  await spawn(["git", "init"]);
  writeFileSync(join(storeDir, ".gitignore"), ".tasks-lock\n", "utf-8");
  await spawn(["git", "add", ".gitignore"]);
  await spawn(["git", "commit", "-m", "init"]);
  writeFileSync(join(storeDir, "meta.yaml"), "next_id: 1\n", "utf-8");
  await spawn(["git", "add", "meta.yaml"]);
  await spawn(["git", "commit", "-m", "meta"]);
}

/** Commit all currently-planted task files in the store. */
async function commitStore(storeDir: string): Promise<void> {
  const git = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: storeDir, stdout: "pipe", stderr: "pipe" }).exited;
  await git(["add", "."]);
  await git(["commit", "-m", "seed tasks"]);
}

/**
 * Derive the store path from tasksHome + encoded cwd.
 */
function deriveStorePath(tasksHome: string, cwd: string): string {
  const realCwd = realpathSync(cwd);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

/** Seed the spec's 10-task dataset and commit it. */
async function seedSpecDataset(storeDir: string): Promise<void> {
  await initBareStore(storeDir);
  plantTask(storeDir, "doing", 1, "Design auth API surface");
  plantTask(storeDir, "backlog", 2, "Implement JWT signing helper", { deps: [1] });
  plantTask(storeDir, "backlog", 3, "Wire login endpoint", { deps: [1, 2] });
  plantTask(storeDir, "backlog", 4, "Add refresh token rotation", { deps: [3], attendance: "unattended" });
  plantTask(storeDir, "doing", 5, "Migrate users table to v2");
  plantTask(storeDir, "backlog", 6, "Backfill missing email_verified flag", { deps: [5], attendance: "unattended" });
  plantTask(storeDir, "backlog", 7, "Write integration tests for auth", { deps: [3, 4] });
  plantTask(storeDir, "backlog", 8, "Document auth flow in README", { deps: [7] });
  plantTask(storeDir, "review", 9, "Audit npm deps for CVEs", { attendance: "unattended" });
  plantTask(storeDir, "done", 10, "Ship v1.2 release notes");
  await commitStore(storeDir);
}

// ─── CLI E2E: tasks board on uninitialized store ─────────────────────────────

test("tasks board on uninitialized store exits non-zero with NOT_INITIALIZED (plain)", async () => {
  const { exitCode, stderr } = await runTasks(["board"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("NOT_INITIALIZED");
});

test("tasks board --json on uninitialized store exits non-zero with NOT_INITIALIZED (json)", async () => {
  const { exitCode, stderr } = await runTasks(["board", "--json"]);
  expect(exitCode).not.toBe(0);
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  const error = parsed.error as Record<string, unknown>;
  expect(error.code).toBe("NOT_INITIALIZED");
});

// ─── CLI E2E: tasks board horizontal lane rendering (wide) ───────────────────

test("tasks board (wide) renders all six lanes side-by-side with caps headers and counts", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "160" });
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n");
  const headerLine = lines[0];

  // Uniform ALL-CAPS headers with counts, in lifecycle order, on one line.
  expect(headerLine.indexOf("BACKLOG (6)")).toBeGreaterThanOrEqual(0);
  for (const [a, b] of [
    ["BACKLOG (6)", "READY (0)"],
    ["READY (0)", "DOING (2)"],
    ["DOING (2)", "BLOCKED (0)"],
    ["BLOCKED (0)", "REVIEW (1)"],
    ["REVIEW (1)", "DONE (1)"],
  ]) {
    expect(headerLine.indexOf(a)).toBeLessThan(headerLine.indexOf(b));
    expect(headerLine.indexOf(a)).toBeGreaterThanOrEqual(0);
  }

  // Lanes are separated by " │ " (space-pipe-space).
  expect(headerLine).toContain(" │ ");

  // Rule line of box-drawing dashes under the headers.
  expect(lines[1]).toContain("─");

  // No old glyphs / markers anywhere.
  expect(stdout).not.toContain("○");
  expect(stdout).not.toContain("●");
  expect(stdout).not.toContain("·M");
  expect(stdout).not.toContain("(empty)");
  expect(stdout).not.toContain("[blocked by");
});

test("tasks board (wide) shows empty lanes as slim 'no tasks' bodies", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "160" });
  expect(exitCode).toBe(0);

  // ready and blocked are empty → "no tasks" appears (at least twice).
  const noTasksCount = stdout.split("no tasks").length - 1;
  expect(noTasksCount).toBeGreaterThanOrEqual(2);
});

/**
 * Extract the cell for a given lane index (0=backlog … 5=done) from the
 * board row that contains `needle` somewhere in that cell.
 */
function laneCell(stdout: string, laneIdx: number, needle: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const cells = line.split(" │ ");
    if (laneIdx < cells.length && cells[laneIdx].includes(needle)) return cells[laneIdx];
  }
  return undefined;
}

test("tasks board (wide) shows [auto] tag only on unattended rows, per-lane gutter", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "160" });
  expect(exitCode).toBe(0);

  // backlog lane (index 0): #4 and #6 are unattended → carry [auto].
  expect(laneCell(stdout, 0, "Add refresh")).toContain("[auto]");
  expect(laneCell(stdout, 0, "Backfill")).toContain("[auto]");
  // review lane (index 4): #9 is unattended → carries [auto].
  expect(laneCell(stdout, 4, "Audit npm")).toContain("[auto]");

  // Attended backlog rows (#2, #3) do NOT carry the tag.
  expect(laneCell(stdout, 0, "Implement JWT")).not.toContain("[auto]");

  // doing lane (index 2) has no unattended task → no gutter, no [auto].
  expect(laneCell(stdout, 2, "Design auth API")).not.toContain("[auto]");

  // The whole render has exactly three [auto] tags.
  expect(stdout.split("[auto]").length - 1).toBe(3);
});

test("tasks board (wide) right-pins dependency arrows with +k overflow", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "160" });
  expect(exitCode).toBe(0);

  // Single dep → "← #N" with no overflow (backlog lane).
  const cell2 = laneCell(stdout, 0, "Implement JWT")!;
  expect(cell2).toContain("← #1");
  expect(cell2).not.toMatch(/← #1 \+/);

  // Multiple deps → "← #first +k".
  expect(laneCell(stdout, 0, "Wire login")).toMatch(/← #1 \+1/);
  expect(laneCell(stdout, 0, "Write integrat")).toMatch(/← #3 \+1/);

  // doing lane has no deps → no arrow in its task cells.
  expect(laneCell(stdout, 2, "Design auth API")).not.toContain("←");
  // review/done lanes likewise carry no arrows.
  expect(laneCell(stdout, 4, "Audit npm")).not.toContain("←");
  expect(laneCell(stdout, 5, "Ship v1.2")).not.toContain("←");
});

test("tasks board (wide) orders rows short-id ascending within a lane", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "160" });
  const lines = stdout.split("\n");
  const idx2 = lines.findIndex((l) => l.includes("Implement JWT"));
  const idx8 = lines.findIndex((l) => l.includes("Document auth"));
  expect(idx2).toBeGreaterThan(0);
  expect(idx8).toBeGreaterThan(idx2);
});

test("tasks board honors --no-color (no ANSI escapes)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "160", FORCE_COLOR: "1" });
  expect(exitCode).toBe(0);
  expect(stdout).not.toMatch(/\x1b\[/);
});

test("tasks board colored output strips to the plain output byte-for-byte", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const colored = await runTasks(["board"], { COLUMNS: "160", FORCE_COLOR: "1" });
  const plain = await runTasks(["board", "--no-color"], { COLUMNS: "160" });
  const stripped = colored.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  expect(stripped).toBe(plain.stdout);
  // Headers are emitted bold in the colored variant.
  expect(colored.stdout).toContain("\x1b[1mBACKLOG (6)\x1b[0m");
});

// ─── CLI E2E: tasks board --json (unchanged shape) ───────────────────────────

test("tasks board --json returns object with all six column keys", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "alpha");
  plantTask(storeDir, "ready", 2, "beta");
  await commitStore(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  for (const col of COLUMNS) {
    expect(parsed).toHaveProperty(col);
    expect(Array.isArray(parsed[col])).toBe(true);
  }

  expect((parsed.backlog as unknown[]).length).toBe(1);
  expect((parsed.ready as unknown[]).length).toBe(1);
  expect((parsed.doing as unknown[]).length).toBe(0);
  expect((parsed.blocked as unknown[]).length).toBe(0);
  expect((parsed.review as unknown[]).length).toBe(0);
  expect((parsed.done as unknown[]).length).toBe(0);

  const t = (parsed.backlog as Array<Record<string, unknown>>)[0];
  expect(t.id).toBe(1);
  expect(t.title).toBe("alpha");
  expect(t.column).toBe("backlog");
  expect(typeof t.uuid).toBe("string");
  expect(Array.isArray(t.deps)).toBe(true);
});

test("tasks board --json on empty (initialized) store returns all six columns with empty arrays", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--json"]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  for (const col of COLUMNS) {
    expect(parsed).toHaveProperty(col);
    expect((parsed[col] as unknown[]).length).toBe(0);
  }
});

// ─── CLI E2E: tasks board adaptive lane dropping ──────────────────────────────

test("tasks board COLUMNS=120 drops done lane and shows hidden-lanes footer", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "120" });
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n");
  const headerLine = lines[0];

  // 5 visible lanes: BACKLOG, READY, DOING, BLOCKED, REVIEW
  expect(headerLine).toContain("BACKLOG (6)");
  expect(headerLine).toContain("READY (0)");
  expect(headerLine).toContain("DOING (2)");
  expect(headerLine).toContain("BLOCKED (0)");
  expect(headerLine).toContain("REVIEW (1)");

  // DONE should NOT appear in the header line
  expect(headerLine).not.toContain("DONE (1)");

  // Check lifecycle order in header
  for (const [a, b] of [
    ["BACKLOG (6)", "READY (0)"],
    ["READY (0)", "DOING (2)"],
    ["DOING (2)", "BLOCKED (0)"],
    ["BLOCKED (0)", "REVIEW (1)"],
  ]) {
    expect(headerLine.indexOf(a)).toBeLessThan(headerLine.indexOf(b));
  }

  // Footer line present
  expect(stdout).toContain("hidden: done (1) · widen terminal or run `tasks list` to see all");

  // Existing lane content still correct
  const backlogLine = lines.find((l) => l.includes("Implement JWT"));
  expect(backlogLine).toBeDefined();
  expect(backlogLine).toContain("← #1");
});

test("tasks board COLUMNS=95 drops done and review lanes, shows multi-hidden footer", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "95" });
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n");
  const headerLine = lines[0];

  // 4 visible lanes: BACKLOG, READY, DOING, BLOCKED
  expect(headerLine).toContain("BACKLOG (6)");
  expect(headerLine).toContain("READY (0)");
  expect(headerLine).toContain("DOING (2)");
  expect(headerLine).toContain("BLOCKED (0)");

  // REVIEW and DONE should NOT appear in the header line
  expect(headerLine).not.toContain("REVIEW");
  expect(headerLine).not.toContain("DONE");

  // Footer with both hidden lanes in lifecycle order
  expect(stdout).toContain("hidden: review (1), done (1) · widen terminal or run `tasks list` to see all");
});

test("tasks board without COLUMNS env var defaults to 120-col layout (drops done)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  // No COLUMNS set — default is 120
  const { exitCode, stdout } = await runTasks(["board", "--no-color"]);
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n");
  const headerLine = lines[0];

  // Same 5-lane behavior as explicit COLUMNS=120
  expect(headerLine).toContain("BACKLOG (6)");
  expect(headerLine).toContain("READY (0)");
  expect(headerLine).toContain("DOING (2)");
  expect(headerLine).toContain("BLOCKED (0)");
  expect(headerLine).toContain("REVIEW (1)");
  expect(headerLine).not.toContain("DONE (1)");

  expect(stdout).toContain("hidden: done (1) · widen terminal or run `tasks list` to see all");
});

test("tasks board COLUMNS=160 shows no hidden footer", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "160" });
  expect(exitCode).toBe(0);

  const headerLine = stdout.split("\n")[0];

  // All six lanes visible
  expect(headerLine).toContain("DONE (1)");
  expect(headerLine).toContain("REVIEW (1)");

  // No hidden footer
  expect(stdout).not.toContain("hidden:");
});

// ─── CLI E2E: tasks board vertical fallback ─────────────────────────────────

test("tasks board COLUMNS=55 renders vertical stacked layout with advisory line", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "55" });
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n");

  // Advisory line first
  expect(lines[0]).toBe("terminal narrow (55 cols) · using vertical layout");
  // Blank line after advisory
  expect(lines[1]).toBe("");

  // All six lanes present as stacked blocks in lifecycle order
  const laneHeaders = lines.filter((l) => /^[A-Z]+ \(\d+\)$/.test(l));
  expect(laneHeaders).toEqual([
    "BACKLOG (6)",
    "READY (0)",
    "DOING (2)",
    "BLOCKED (0)",
    "REVIEW (1)",
    "DONE (1)",
  ]);

  // Each header is followed by a rule line
  for (const header of laneHeaders) {
    const idx = lines.indexOf(header);
    expect(lines[idx + 1]).toMatch(/^─+$/);
  }

  // Empty lanes show "no tasks"
  const readyIdx = lines.indexOf("READY (0)");
  expect(lines[readyIdx + 2]).toBe("no tasks");
  const blockedIdx = lines.indexOf("BLOCKED (0)");
  expect(lines[blockedIdx + 2]).toBe("no tasks");

  // Dependency arrows still present in vertical layout
  const jwtLine = lines.find((l) => l.includes("Implement JWT"));
  expect(jwtLine).toContain("← #1");

  // [auto] tags still present
  const refreshLine = lines.find((l) => l.includes("Add refresh"));
  expect(refreshLine).toContain("[auto]");

  // No hidden footer in vertical mode
  expect(stdout).not.toContain("hidden:");
});

test("tasks board vertical fallback rule line spans header text width, not lane width", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "55" });
  expect(exitCode).toBe(0);

  const lines = stdout.split("\n");
  // "BACKLOG (6)" is 11 chars → rule should be 11 dashes
  const backlogIdx = lines.indexOf("BACKLOG (6)");
  expect(lines[backlogIdx + 1]).toBe("─".repeat(11));
  // "DOING (2)" is 9 chars → rule should be 9 dashes
  const doingIdx = lines.indexOf("DOING (2)");
  expect(lines[doingIdx + 1]).toBe("─".repeat(9));
});

test("tasks board vertical fallback uses full content width for titles", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await seedSpecDataset(storeDir);

  const { exitCode, stdout } = await runTasks(["board", "--no-color"], { COLUMNS: "55" });
  expect(exitCode).toBe(0);

  // In vertical mode titles get more room than in the narrow horizontal lanes.
  // "Write integration tests for auth" (33 chars) should NOT be truncated at 55 cols.
  const authLine = stdout.split("\n").find((l) => l.includes("Write integration tests for auth"));
  expect(authLine).toBeDefined();
});
