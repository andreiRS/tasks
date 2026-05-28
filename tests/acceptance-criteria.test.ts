import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-ac-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-ac-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

/**
 * Create a task with a body piped via `--body -`. Returns the resulting short id.
 */
async function newTaskWithBody(title: string, body: string): Promise<number> {
  const proc = Bun.spawn(["bun", "run", cliPath, "new", title, "--body", "-"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  proc.stdin.write(body);
  await proc.stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`new failed (exit ${exitCode}): ${err}`);
  }
  const out = await new Response(proc.stdout).text();
  const m = /#(\d+)/.exec(out);
  if (!m) throw new Error(`could not parse id from: ${out}`);
  return parseInt(m[1], 10);
}

async function newEmptyTask(title: string): Promise<number> {
  const proc = Bun.spawn(["bun", "run", cliPath, "new", title], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`new failed (exit ${exitCode}): ${err}`);
  }
  const out = await new Response(proc.stdout).text();
  const m = /#(\d+)/.exec(out);
  if (!m) throw new Error(`could not parse id from: ${out}`);
  return parseInt(m[1], 10);
}

async function runTasks(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

async function showJson(id: number): Promise<Record<string, unknown>> {
  const { exitCode, stdout } = await runTasks(["show", String(id), "--json"]);
  expect(exitCode).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

// ─── show --json field shape ─────────────────────────────────────────────────

test("show --json: empty body yields acceptance_criteria empty string", async () => {
  const id = await newEmptyTask("empty body");
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe("");
  expect(parsed.body).toBe("");
});

test("show --json: body without AC heading yields empty string", async () => {
  const id = await newTaskWithBody("no heading", "Just some prose.\n\nMore lines.\n");
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe("");
});

test("show --json: simple AC section extracted, EOF terminates", async () => {
  const body = "intro line\n\n## Acceptance Criteria\n- first\n- second\n";
  const id = await newTaskWithBody("simple", body);
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe("- first\n- second");
});

test("show --json: section terminated by next ## heading", async () => {
  const body = "## Acceptance Criteria\n- one\n- two\n\n## Notes\nafter\n";
  const id = await newTaskWithBody("term ##", body);
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe("- one\n- two");
});

test("show --json: section terminated by ### heading (any level >= 2)", async () => {
  const body = "## Acceptance Criteria\nA\nB\n### subhead\nafter\n";
  const id = await newTaskWithBody("term ###", body);
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe("A\nB");
});

test("show --json: heading match is case-insensitive (ALL CAPS)", async () => {
  const body = "## ACCEPTANCE CRITERIA\ncontent\n";
  const id = await newTaskWithBody("caps", body);
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe("content");
});

test("show --json: heading match is case-insensitive (mixed)", async () => {
  const body = "## Acceptance criteria\ncontent\n";
  const id = await newTaskWithBody("mixed", body);
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe("content");
});

test("show --json: heading inside ``` fenced block is ignored", async () => {
  const body = "```\n## Acceptance Criteria\nfake\n```\nreal body\n";
  const id = await newTaskWithBody("fenced bt", body);
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe("");
});

test("show --json: heading inside ~~~ fenced block is ignored", async () => {
  const body = "~~~\n## Acceptance Criteria\nfake\n~~~\nreal body\n";
  const id = await newTaskWithBody("fenced tl", body);
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe("");
});

test("show --json: ## heading inside fence does not terminate section", async () => {
  const body = [
    "## Acceptance Criteria",
    "before fence",
    "```",
    "## Not A Heading",
    "code line",
    "```",
    "after fence",
  ].join("\n") + "\n";
  const id = await newTaskWithBody("fence inside", body);
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe(
    "before fence\n```\n## Not A Heading\ncode line\n```\nafter fence"
  );
});

test("show --json: leading and trailing blank lines trimmed; internal preserved", async () => {
  const body = "## Acceptance Criteria\n\n\nline A\n\nline B\n\n\n## Next\n";
  const id = await newTaskWithBody("trim blanks", body);
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe("line A\n\nline B");
});

test("show --json: internal markdown (lists, code) preserved verbatim", async () => {
  const body = [
    "## Acceptance Criteria",
    "- item 1",
    "  - nested",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "final",
  ].join("\n") + "\n";
  const id = await newTaskWithBody("verbatim", body);
  const parsed = await showJson(id);
  expect(parsed.acceptance_criteria).toBe(
    "- item 1\n  - nested\n\n```js\nconst x = 1;\n```\n\nfinal"
  );
});

// ─── Cross-command consistency: list, board, next ────────────────────────────

test("list --json: acceptance_criteria emitted on every task", async () => {
  await newEmptyTask("no body");
  await newTaskWithBody("with ac", "## Acceptance Criteria\nx\n");

  const { exitCode, stdout } = await runTasks(["list", "--json"]);
  expect(exitCode).toBe(0);
  const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(arr.length).toBe(2);
  const byId = new Map(arr.map((t) => [t.id as number, t]));
  expect(byId.get(1)!.acceptance_criteria).toBe("");
  expect(byId.get(2)!.acceptance_criteria).toBe("x");
  // body still exposed
  expect(typeof byId.get(1)!.body).toBe("string");
});

test("board --json: acceptance_criteria emitted on every task", async () => {
  await newTaskWithBody("with ac", "## Acceptance Criteria\nboard ac\n");

  const { exitCode, stdout } = await runTasks(["board", "--json"]);
  expect(exitCode).toBe(0);
  const grouped = JSON.parse(stdout) as Record<string, Array<Record<string, unknown>>>;
  const task = grouped.backlog[0];
  expect(task.acceptance_criteria).toBe("board ac");
  expect(typeof task.body).toBe("string");
});

test("next --json: acceptance_criteria emitted on the picked task", async () => {
  const id = await newTaskWithBody("ready ac", "## Acceptance Criteria\nnext ac\n");
  // Move to ready/
  const mv = await runTasks(["mv", String(id), "ready"]);
  expect(mv.exitCode).toBe(0);

  const { exitCode, stdout } = await runTasks(["next", "--json"]);
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(parsed.acceptance_criteria).toBe("next ac");
  expect(typeof parsed.body).toBe("string");
});
