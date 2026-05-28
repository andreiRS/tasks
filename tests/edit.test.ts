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
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-edit-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-edit-cwd-"));
  editorScriptDir = mkdtempSync(join(tmpdir(), "tasks-edit-editor-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
  rmSync(editorScriptDir, { recursive: true, force: true });
});

/** Run a tasks CLI command. */
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

async function plantTask(title: string = "a task"): Promise<number> {
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

/**
 * Write an editor script that, when invoked as `$EDITOR <file>`, overwrites
 * that file with the contents of `replacementContent`. Returns the absolute
 * path to the script (suitable for `EDITOR=...`).
 */
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

// ─── Test 1: body-only edit ──────────────────────────────────────────────────

test("tasks edit (body-only): commits, bumps updated_at, filename unchanged", async () => {
  const id = await plantTask("keep this title");
  const storeDir = deriveStoreDir();
  const filesBefore = filesInColumn(storeDir, "backlog");
  expect(filesBefore.length).toBe(1);
  const filename = filesBefore[0];

  const rawBefore = readTaskFile(storeDir, "backlog", filename);
  const { fm: fmBefore } = parseTask(rawBefore);

  const replacement = `---
id: ${fmBefore.id}
uuid: ${fmBefore.uuid}
title: ${fmBefore.title}
created_at: ${fmBefore.created_at}
updated_at: ${fmBefore.updated_at}
---
new body content here
`;
  const editor = makeReplaceEditor(replacement, "body");

  const commitsBefore = await gitLogCount(storeDir);

  // Ensure updated_at can advance even at millisecond resolution
  await new Promise((r) => setTimeout(r, 10));

  const { exitCode, stderr } = await runTasks(["edit", String(id)], { EDITOR: editor });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("INVALID");

  // Filename unchanged
  expect(filesInColumn(storeDir, "backlog")).toEqual([filename]);

  // One new commit
  expect(await gitLogCount(storeDir)).toBe(commitsBefore + 1);

  const rawAfter = readTaskFile(storeDir, "backlog", filename);
  const { fm: fmAfter, body: bodyAfter } = parseTask(rawAfter);
  expect(bodyAfter).toContain("new body content here");
  expect(fmAfter.updated_at).not.toBe(fmBefore.updated_at);
  expect(fmAfter.title).toBe(fmBefore.title);
});

// ─── Test 2: no-op edit ──────────────────────────────────────────────────────

test("tasks edit (no-op): identical save yields exit 0 and no new commit", async () => {
  const id = await plantTask("idempotent edit");
  const storeDir = deriveStoreDir();
  const filename = filesInColumn(storeDir, "backlog")[0];
  const rawBefore = readTaskFile(storeDir, "backlog", filename);

  // EDITOR=true: do nothing.
  const commitsBefore = await gitLogCount(storeDir);
  const { exitCode } = await runTasks(["edit", String(id)], { EDITOR: "true" });
  expect(exitCode).toBe(0);
  expect(await gitLogCount(storeDir)).toBe(commitsBefore);

  const rawAfter = readTaskFile(storeDir, "backlog", filename);
  expect(rawAfter).toBe(rawBefore);
});

// ─── Test 3: title-change edit ───────────────────────────────────────────────

test("tasks edit (title change): file renamed via git mv, single commit", async () => {
  const id = await plantTask("old title here");
  const storeDir = deriveStoreDir();
  const oldFilename = filesInColumn(storeDir, "backlog")[0];

  const rawBefore = readTaskFile(storeDir, "backlog", oldFilename);
  const { fm: fmBefore } = parseTask(rawBefore);

  const newTitle = "brand new title";
  const replacement = `---
id: ${fmBefore.id}
uuid: ${fmBefore.uuid}
title: ${newTitle}
created_at: ${fmBefore.created_at}
updated_at: ${fmBefore.updated_at}
---
body unchanged
`;
  const editor = makeReplaceEditor(replacement, "title");

  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode } = await runTasks(["edit", String(id)], { EDITOR: editor });
  expect(exitCode).toBe(0);

  // Old filename gone, new slug-based filename present
  const filesAfter = filesInColumn(storeDir, "backlog");
  expect(filesAfter.length).toBe(1);
  expect(filesAfter[0]).not.toBe(oldFilename);
  expect(filesAfter[0]).toBe(`${id}-brand-new-title.md`);

  // Exactly one new commit
  expect(await gitLogCount(storeDir)).toBe(commitsBefore + 1);

  const rawAfter = readTaskFile(storeDir, "backlog", filesAfter[0]);
  const { fm: fmAfter } = parseTask(rawAfter);
  expect(fmAfter.title).toBe(newTitle);
});

// ─── Test 4: invalid title ───────────────────────────────────────────────────

test("tasks edit (invalid title): INVALID_TITLE, no commit, bad file preserved", async () => {
  const id = await plantTask("valid one");
  const storeDir = deriveStoreDir();
  const filename = filesInColumn(storeDir, "backlog")[0];
  const rawBefore = readTaskFile(storeDir, "backlog", filename);
  const { fm: fmBefore } = parseTask(rawBefore);

  const longTitle = "x".repeat(250);
  const replacement = `---
id: ${fmBefore.id}
uuid: ${fmBefore.uuid}
title: "${longTitle}"
created_at: ${fmBefore.created_at}
updated_at: ${fmBefore.updated_at}
---
body
`;
  const editor = makeReplaceEditor(replacement, "bad");

  const commitsBefore = await gitLogCount(storeDir);

  // Plain mode
  const { exitCode, stderr } = await runTasks(["edit", String(id)], { EDITOR: editor });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_TITLE");
  expect(() => JSON.parse(stderr)).toThrow();

  // No new commit
  expect(await gitLogCount(storeDir)).toBe(commitsBefore);

  // File on disk is the bad edited content (not reverted)
  const rawAfter = readTaskFile(storeDir, "backlog", filename);
  expect(rawAfter).toContain(longTitle);

  // After the bad save the store is dirty. Use --abort to reset before JSON retry.
  const { exitCode: abortExit } = await runTasks(["edit", "--abort"]);
  expect(abortExit).toBe(0);

  // Re-edit invalid with --json
  const editor2 = makeReplaceEditor(replacement, "bad2");
  const { exitCode: e2, stderr: stderr2 } = await runTasks(["edit", String(id), "--json"], { EDITOR: editor2 });
  expect(e2).not.toBe(0);
  const parsed = JSON.parse(stderr2) as Record<string, unknown>;
  expect((parsed.error as Record<string, unknown>).code).toBe("INVALID_TITLE");
});

// ─── Test 5: EDITOR unset ────────────────────────────────────────────────────

test("tasks edit with EDITOR unset: NO_EDITOR", async () => {
  const id = await plantTask("needs editor");
  const { exitCode, stderr } = await runTasks(["edit", String(id)], { EDITOR: undefined, VISUAL: undefined });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("NO_EDITOR");
});

// ─── Test 6: EDITOR exits non-zero ───────────────────────────────────────────

test("tasks edit with EDITOR=false: EDITOR_FAILED, no commit", async () => {
  const id = await plantTask("editor fails");
  const storeDir = deriveStoreDir();
  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode, stderr } = await runTasks(["edit", String(id)], { EDITOR: "false" });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("EDITOR_FAILED");
  expect(await gitLogCount(storeDir)).toBe(commitsBefore);
});

// ─── Test 7: NOT_FOUND ───────────────────────────────────────────────────────

test("tasks edit on unknown id: NOT_FOUND", async () => {
  await plantTask("planted");
  const { exitCode, stderr } = await runTasks(["edit", "999"], { EDITOR: "true" });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("NOT_FOUND");
});

// ─── Test 8: dirty-tree exemption ────────────────────────────────────────────

test("tasks edit is exempt from STORE_DIRTY guard; only its own changes are committed", async () => {
  const id = await plantTask("dirty exempt");
  const storeDir = deriveStoreDir();
  const filename = filesInColumn(storeDir, "backlog")[0];

  // Pre-dirty the store with an untracked file
  writeFileSync(join(storeDir, "dirt.txt"), "untracked mess\n", "utf-8");

  const rawBefore = readTaskFile(storeDir, "backlog", filename);
  const { fm: fmBefore } = parseTask(rawBefore);
  const replacement = `---
id: ${fmBefore.id}
uuid: ${fmBefore.uuid}
title: ${fmBefore.title}
created_at: ${fmBefore.created_at}
updated_at: ${fmBefore.updated_at}
---
edited despite dirty tree
`;
  const editor = makeReplaceEditor(replacement, "dirty");

  const { exitCode, stderr } = await runTasks(["edit", String(id)], { EDITOR: editor });
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("STORE_DIRTY");

  // dirt.txt is still untracked / uncommitted (only the edit was committed)
  expect(existsSync(join(storeDir, "dirt.txt"))).toBe(true);
  const gitBin = Bun.which("git") ?? "/opt/homebrew/bin/git";
  const statusProc = Bun.spawn([gitBin, "status", "--porcelain"], {
    cwd: storeDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await statusProc.exited;
  const statusOut = await new Response(statusProc.stdout).text();
  expect(statusOut).toContain("dirt.txt");

  const rawAfter = readTaskFile(storeDir, "backlog", filename);
  expect(rawAfter).toContain("edited despite dirty tree");
});

// ─── Test 9: editor leaves stray files (vim swap, nano backup, .DS_Store) ────

test("tasks edit followed by another mutation: editor swap/backup files must not trip STORE_DIRTY", async () => {
  const id = await plantTask("subject task");
  const storeDir = deriveStoreDir();
  const filename = filesInColumn(storeDir, "backlog")[0];

  // Editor that modifies the file AND leaves a vim-style swap file behind,
  // a nano-style backup, and a macOS .DS_Store — all common in real-world use.
  const replacementPath = join(editorScriptDir, "stray-content.txt");
  const rawBefore = readTaskFile(storeDir, "backlog", filename);
  const { fm: fmBefore } = parseTask(rawBefore);
  const replacement = `---
id: ${fmBefore.id}
uuid: ${fmBefore.uuid}
title: ${fmBefore.title}
created_at: ${fmBefore.created_at}
updated_at: ${fmBefore.updated_at}
---
edited body
`;
  writeFileSync(replacementPath, replacement, "utf-8");
  const scriptPath = join(editorScriptDir, "stray-editor.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
DIR=$(dirname "$1")
BASE=$(basename "$1")
cp "${replacementPath}" "$1"
# vim-style swap file
touch "$DIR/.\${BASE}.swp"
# nano/emacs-style backup file
touch "$DIR/\${BASE}~"
# macOS Finder droppings
touch "$DIR/.DS_Store"
`,
    "utf-8",
  );
  chmodSync(scriptPath, 0o755);

  const { exitCode: editExit } = await runTasks(["edit", String(id)], { EDITOR: scriptPath });
  expect(editExit).toBe(0);

  // Every subsequent mutating command (new, mv, rm) must survive editor-droppings.
  // Today they all fail with STORE_DIRTY because the droppings are untracked in
  // the store git tree.
  const { exitCode: newExit, stderr: newStderr } = await runTasks(["new", "follow-up task"]);
  expect(newStderr).not.toContain("STORE_DIRTY");
  expect(newExit).toBe(0);

  const { exitCode: mvExit, stderr: mvStderr } = await runTasks(["mv", String(id), "doing"]);
  expect(mvStderr).not.toContain("STORE_DIRTY");
  expect(mvExit).toBe(0);

  const { exitCode: rmExit, stderr: rmStderr } = await runTasks(["rm", String(id), "--force"]);
  expect(rmStderr).not.toContain("STORE_DIRTY");
  expect(rmExit).toBe(0);
});

// ─── Test 10: --abort ────────────────────────────────────────────────────────

test("tasks edit --abort resets working tree to HEAD", async () => {
  const id = await plantTask("revertable");
  const storeDir = deriveStoreDir();
  const filename = filesInColumn(storeDir, "backlog")[0];
  const filePath = join(storeDir, "backlog", filename);
  const rawBefore = readFileSync(filePath, "utf-8");

  // Manually corrupt the file on disk (not via the edit command)
  writeFileSync(filePath, "corrupted content\n", "utf-8");
  expect(readFileSync(filePath, "utf-8")).toBe("corrupted content\n");

  const commitsBefore = await gitLogCount(storeDir);

  const { exitCode } = await runTasks(["edit", "--abort"]);
  expect(exitCode).toBe(0);

  // File restored to HEAD content
  expect(readFileSync(filePath, "utf-8")).toBe(rawBefore);
  // No new commit
  expect(await gitLogCount(storeDir)).toBe(commitsBefore);
  // id arg silenced for --abort branch
  void id;
});
