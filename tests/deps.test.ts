import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

let tasksHome: string;
let cwdDir: string;
let cliPath: string;
let editorScriptDir: string;

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-deps-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-deps-cwd-"));
  editorScriptDir = mkdtempSync(join(tmpdir(), "tasks-deps-editor-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
  rmSync(editorScriptDir, { recursive: true, force: true });
});

async function runTasks(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = { ...process.env, TASKS_HOME: tasksHome } as Record<string, string>;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    env,
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

async function plantTask(title: string): Promise<number> {
  const { exitCode, stdout, stderr } = await runTasks(["new", title]);
  if (exitCode !== 0) throw new Error(`plantTask failed: ${stderr}`);
  const m = /new #(\d+)/.exec(stdout);
  if (!m) throw new Error(`plantTask: bad stdout ${stdout}`);
  return parseInt(m[1], 10);
}

async function gitLogCount(storeDir: string): Promise<number> {
  const gitBin = Bun.which("git") ?? "/opt/homebrew/bin/git";
  const proc = Bun.spawn([gitBin, "log", "--oneline"], {
    cwd: storeDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const out = await new Response(proc.stdout).text();
  return out.trim() === "" ? 0 : out.trim().split("\n").length;
}

function deriveStoreDir(): string {
  const realCwd = realpathSync(cwdDir);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

function filesInColumn(storeDir: string, col: string): string[] {
  const colDir = join(storeDir, col);
  if (!existsSync(colDir)) return [];
  return readdirSync(colDir).filter((f) => f.endsWith(".md"));
}

function makeReplaceEditor(replacementContent: string, tag: string = "ed"): string {
  const replacementPath = join(editorScriptDir, `${tag}-content.txt`);
  writeFileSync(replacementPath, replacementContent, "utf-8");
  const scriptPath = join(editorScriptDir, `${tag}-editor.sh`);
  writeFileSync(
    scriptPath,
    `#!/bin/sh\ncp "${replacementPath}" "$1"\n`,
    "utf-8",
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function readTaskFile(storeDir: string, col: string, filename: string): string {
  return readFileSync(join(storeDir, col, filename), "utf-8");
}

function parseTask(raw: string): { fm: Record<string, unknown>; body: string } {
  const parts = raw.split(/^---\s*$/m);
  const fm = parseYaml(parts[1]) as Record<string, unknown>;
  const rawBody = parts.slice(2).join("---");
  const body = rawBody.startsWith("\n") ? rawBody.slice(1) : rawBody;
  return { fm, body };
}

// ─── Test 1: `tasks new` writes deps: [] on disk ─────────────────────────────

test("tasks new writes deps: [] on disk", async () => {
  await plantTask("first task");
  const storeDir = deriveStoreDir();
  const filename = filesInColumn(storeDir, "backlog")[0];
  const raw = readTaskFile(storeDir, "backlog", filename);
  const { fm } = parseTask(raw);
  expect(Array.isArray(fm.deps)).toBe(true);
  expect((fm.deps as unknown[]).length).toBe(0);
  // Pinned on-disk shape: an explicit deps key is present
  expect(/^deps:/m.test(raw)).toBe(true);
});

// ─── Test 2: `tasks show --json` returns deps: [] for fresh task ─────────────

test("tasks show --json returns deps: [] for fresh task", async () => {
  const id = await plantTask("freshie");
  const { exitCode, stdout } = await runTasks(["show", String(id), "--json"]);
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(Array.isArray(parsed.deps)).toBe(true);
  expect((parsed.deps as unknown[]).length).toBe(0);
});

// ─── Test 3: edit injecting a bogus uuid → UNKNOWN_UUID ───────────────────────

test("tasks edit with bogus dep uuid: UNKNOWN_UUID, no commit (plain + --json)", async () => {
  const id = await plantTask("has bogus dep");
  const storeDir = deriveStoreDir();
  const filename = filesInColumn(storeDir, "backlog")[0];
  const raw = readTaskFile(storeDir, "backlog", filename);
  const { fm } = parseTask(raw);

  const bogus = "00000000-0000-4000-8000-000000000000";
  const replacement = `---
id: ${fm.id}
uuid: ${fm.uuid}
title: ${fm.title}
deps: ["${bogus}"]
created_at: ${fm.created_at}
updated_at: ${fm.updated_at}
---
body
`;
  const editor = makeReplaceEditor(replacement, "bogus");
  const commitsBefore = await gitLogCount(storeDir);

  // Plain
  const { exitCode, stderr } = await runTasks(["edit", String(id)], { EDITOR: editor });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("UNKNOWN_UUID");
  expect(await gitLogCount(storeDir)).toBe(commitsBefore);

  // Recover, then re-edit with --json
  const { exitCode: ae } = await runTasks(["edit", "--abort"]);
  expect(ae).toBe(0);

  const editor2 = makeReplaceEditor(replacement, "bogus2");
  const { exitCode: e2, stderr: stderr2 } = await runTasks(["edit", String(id), "--json"], { EDITOR: editor2 });
  expect(e2).not.toBe(0);
  const parsed = JSON.parse(stderr2) as Record<string, unknown>;
  expect((parsed.error as Record<string, unknown>).code).toBe("UNKNOWN_UUID");
});

// ─── Test 4: edit adds a valid dep → succeeds and persists ───────────────────

test("tasks edit with valid dep uuid: succeeds, commit lands, dep persisted", async () => {
  const idA = await plantTask("task A");
  const idB = await plantTask("task B");
  const storeDir = deriveStoreDir();

  // Find B's uuid
  const showB = await runTasks(["show", String(idB), "--json"]);
  const taskB = JSON.parse(showB.stdout) as { uuid: string };

  // Find A's filename and read fm
  const aFilename = filesInColumn(storeDir, "backlog").find((f) => f.startsWith(`${idA}-`))!;
  const rawA = readTaskFile(storeDir, "backlog", aFilename);
  const { fm: fmA } = parseTask(rawA);

  const replacement = `---
id: ${fmA.id}
uuid: ${fmA.uuid}
title: ${fmA.title}
deps: ["${taskB.uuid}"]
created_at: ${fmA.created_at}
updated_at: ${fmA.updated_at}
---
body of A
`;
  const editor = makeReplaceEditor(replacement, "valid");
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["edit", String(idA)], { EDITOR: editor });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("UNKNOWN_UUID");
  expect(await gitLogCount(storeDir)).toBe(commitsBefore + 1);

  // A's deps now include B
  const showA = await runTasks(["show", String(idA), "--json"]);
  const taskA = JSON.parse(showA.stdout) as { deps: string[] };
  expect(taskA.deps).toEqual([taskB.uuid]);

  // B unchanged
  const showB2 = await runTasks(["show", String(idB), "--json"]);
  const taskB2 = JSON.parse(showB2.stdout) as { deps: string[] };
  expect(taskB2.deps).toEqual([]);
});

// ─── Test 5: cycle A -> B -> A rejected ──────────────────────────────────────

test("tasks edit forming a cycle: CYCLE_DETECTED, no commit (plain + --json)", async () => {
  const idA = await plantTask("cyc A");
  const idB = await plantTask("cyc B");
  const storeDir = deriveStoreDir();

  const showA = await runTasks(["show", String(idA), "--json"]);
  const taskA = JSON.parse(showA.stdout) as { uuid: string };
  const showB = await runTasks(["show", String(idB), "--json"]);
  const taskB = JSON.parse(showB.stdout) as { uuid: string };

  // Step 1: A depends on B (succeeds)
  const aFilename1 = filesInColumn(storeDir, "backlog").find((f) => f.startsWith(`${idA}-`))!;
  const rawA1 = readTaskFile(storeDir, "backlog", aFilename1);
  const { fm: fmA } = parseTask(rawA1);
  const replA = `---
id: ${fmA.id}
uuid: ${fmA.uuid}
title: ${fmA.title}
deps: ["${taskB.uuid}"]
created_at: ${fmA.created_at}
updated_at: ${fmA.updated_at}
---
A body
`;
  const edA = makeReplaceEditor(replA, "ab");
  const r1 = await runTasks(["edit", String(idA)], { EDITOR: edA });
  expect(r1.exitCode).toBe(0);

  // Step 2: B depends on A → cycle
  const bFilename = filesInColumn(storeDir, "backlog").find((f) => f.startsWith(`${idB}-`))!;
  const rawB = readTaskFile(storeDir, "backlog", bFilename);
  const { fm: fmB } = parseTask(rawB);
  const replB = `---
id: ${fmB.id}
uuid: ${fmB.uuid}
title: ${fmB.title}
deps: ["${taskA.uuid}"]
created_at: ${fmB.created_at}
updated_at: ${fmB.updated_at}
---
B body
`;
  const edB = makeReplaceEditor(replB, "ba");
  const commitsBefore = await gitLogCount(storeDir);
  const r2 = await runTasks(["edit", String(idB)], { EDITOR: edB });
  expect(r2.exitCode).not.toBe(0);
  expect(r2.stderr).toContain("CYCLE_DETECTED");
  expect(await gitLogCount(storeDir)).toBe(commitsBefore);

  // Recover, then retry --json
  const { exitCode: ae } = await runTasks(["edit", "--abort"]);
  expect(ae).toBe(0);
  const edB2 = makeReplaceEditor(replB, "ba2");
  const r3 = await runTasks(["edit", String(idB), "--json"], { EDITOR: edB2 });
  expect(r3.exitCode).not.toBe(0);
  const parsed = JSON.parse(r3.stderr) as Record<string, unknown>;
  expect((parsed.error as Record<string, unknown>).code).toBe("CYCLE_DETECTED");
});

// ─── Test 6: self-loop rejected ──────────────────────────────────────────────

test("tasks edit creating a self-loop: CYCLE_DETECTED", async () => {
  const id = await plantTask("self loop");
  const storeDir = deriveStoreDir();
  const filename = filesInColumn(storeDir, "backlog")[0];
  const raw = readTaskFile(storeDir, "backlog", filename);
  const { fm } = parseTask(raw);

  const replacement = `---
id: ${fm.id}
uuid: ${fm.uuid}
title: ${fm.title}
deps: ["${fm.uuid}"]
created_at: ${fm.created_at}
updated_at: ${fm.updated_at}
---
self
`;
  const editor = makeReplaceEditor(replacement, "self");
  const commitsBefore = await gitLogCount(storeDir);
  const { exitCode, stderr } = await runTasks(["edit", String(id)], { EDITOR: editor });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("CYCLE_DETECTED");
  expect(await gitLogCount(storeDir)).toBe(commitsBefore);
});
