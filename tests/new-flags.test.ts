import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
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
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-nf-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-nf-cwd-"));
  editorScriptDir = mkdtempSync(join(tmpdir(), "tasks-nf-editor-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
  rmSync(editorScriptDir, { recursive: true, force: true });
});

async function runTasks(
  args: string[],
  opts: {
    extraEnv?: Record<string, string | undefined>;
    stdin?: string;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = { ...process.env, TASKS_HOME: tasksHome } as Record<string, string>;
  for (const [k, v] of Object.entries(opts.extraEnv ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  let stdinPipe: "pipe" | ReadableStream<Uint8Array> | "inherit" = "inherit";
  let stdinStream: ReadableStream<Uint8Array> | undefined;
  if (opts.stdin !== undefined) {
    // encode as ReadableStream
    const enc = new TextEncoder().encode(opts.stdin);
    stdinStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc);
        controller.close();
      },
    });
    stdinPipe = stdinStream;
  }

  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdinPipe,
    cwd: cwdDir,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function getStoreDir(): string {
  const real = realpathSync(cwdDir);
  const encoded = real.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

async function plantTask(title: string = "a task"): Promise<{ id: number; uuid: string }> {
  const { exitCode, stdout, stderr } = await runTasks(["new", title]);
  if (exitCode !== 0) throw new Error(`plantTask failed: ${stderr}`);
  const m = /new #(\d+)/.exec(stdout);
  if (!m) throw new Error(`plantTask: bad stdout "${stdout}"`);
  const id = parseInt(m[1], 10);
  const { stdout: showOut } = await runTasks(["show", String(id), "--json"]);
  const parsed = JSON.parse(showOut) as { uuid: string };
  return { id, uuid: parsed.uuid };
}

function readSingleTaskFm(col: string): Record<string, unknown> {
  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, col)).filter((f) => f.endsWith(".md"));
  expect(files).toHaveLength(1);
  const raw = readFileSync(join(storeDir, col, files[0]), "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  expect(fmMatch).not.toBeNull();
  return parseYaml(fmMatch![1]) as Record<string, unknown>;
}

function readTaskFmByFilename(col: string, filename: string): Record<string, unknown> {
  const storeDir = getStoreDir();
  const raw = readFileSync(join(storeDir, col, filename), "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  expect(fmMatch).not.toBeNull();
  return parseYaml(fmMatch![1]) as Record<string, unknown>;
}

function readTaskBodyByFilename(col: string, filename: string): string {
  const storeDir = getStoreDir();
  const raw = readFileSync(join(storeDir, col, filename), "utf-8");
  const parts = raw.split(/^---\s*$/m);
  const rawBody = parts.slice(2).join("---");
  return rawBody.startsWith("\n") ? rawBody.slice(1) : rawBody;
}

// ─── --unattended ────────────────────────────────────────────────────────────

test("tasks new --unattended writes attendance=unattended to disk", async () => {
  const { exitCode, stderr } = await runTasks(["new", "unattended task", "--unattended"]);
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("error");

  const fm = readSingleTaskFm("backlog");
  expect(fm.attendance).toBe("unattended");
});

test("tasks new without --unattended keeps attendance=attended (default)", async () => {
  await runTasks(["new", "attended task"]);
  const fm = readSingleTaskFm("backlog");
  expect(fm.attendance).toBe("attended");
});

// ─── --effort ────────────────────────────────────────────────────────────────

test("tasks new --effort low writes effort=low to disk", async () => {
  const { exitCode } = await runTasks(["new", "low effort task", "--effort", "low"]);
  expect(exitCode).toBe(0);
  const fm = readSingleTaskFm("backlog");
  expect(fm.effort).toBe("low");
});

test("tasks new --effort high writes effort=high to disk", async () => {
  const { exitCode } = await runTasks(["new", "high effort task", "--effort", "high"]);
  expect(exitCode).toBe(0);
  const fm = readSingleTaskFm("backlog");
  expect(fm.effort).toBe("high");
});

test("tasks new --effort medium writes effort=medium to disk", async () => {
  const { exitCode } = await runTasks(["new", "medium effort task", "--effort", "medium"]);
  expect(exitCode).toBe(0);
  const fm = readSingleTaskFm("backlog");
  expect(fm.effort).toBe("medium");
});

test("tasks new --effort invalid exits non-zero with INVALID_EFFORT", async () => {
  const { exitCode, stderr } = await runTasks(["new", "bad effort task", "--effort", "extreme"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_EFFORT");
});

test("tasks new --effort invalid with --json emits JSON error envelope", async () => {
  const { exitCode, stderr } = await runTasks(["new", "bad effort task", "--effort", "gargantuan", "--json"]);
  expect(exitCode).not.toBe(0);
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  expect(parsed).toHaveProperty("error");
  const err = parsed.error as Record<string, unknown>;
  expect(err.code).toBe("INVALID_EFFORT");
});

test("tasks new without --effort keeps effort=medium (default)", async () => {
  await runTasks(["new", "default effort task"]);
  const fm = readSingleTaskFm("backlog");
  expect(fm.effort).toBe("medium");
});

// ─── --deps ──────────────────────────────────────────────────────────────────

test("tasks new --deps <short-id> writes dep uuid into deps array", async () => {
  const dep = await plantTask("dependency task");

  const { exitCode } = await runTasks(["new", "new task", "--deps", String(dep.id)]);
  expect(exitCode).toBe(0);

  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, "backlog"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  // Second file is the new task (id=2)
  const fm = readTaskFmByFilename("backlog", files[1]);
  const deps = fm.deps as string[];
  expect(Array.isArray(deps)).toBe(true);
  expect(deps).toContain(dep.uuid);
});

test("tasks new --deps <uuid> writes dep uuid into deps array", async () => {
  const dep = await plantTask("dep task by uuid");

  const { exitCode } = await runTasks(["new", "new task by uuid dep", "--deps", dep.uuid]);
  expect(exitCode).toBe(0);

  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, "backlog"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  const fm = readTaskFmByFilename("backlog", files[1]);
  const deps = fm.deps as string[];
  expect(deps).toContain(dep.uuid);
});

test("tasks new --deps repeated writes multiple dep uuids", async () => {
  const dep1 = await plantTask("dep one");
  const dep2 = await plantTask("dep two");

  const { exitCode } = await runTasks(["new", "multi dep task", "--deps", String(dep1.id), "--deps", String(dep2.id)]);
  expect(exitCode).toBe(0);

  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, "backlog"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  const fm = readTaskFmByFilename("backlog", files[2]);
  const deps = fm.deps as string[];
  expect(deps).toContain(dep1.uuid);
  expect(deps).toContain(dep2.uuid);
});

test("tasks new --deps with unknown id exits non-zero with UNKNOWN_UUID", async () => {
  const { exitCode, stderr } = await runTasks(["new", "new task", "--deps", "9999"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("UNKNOWN_UUID");
});

test("tasks new --deps with bad uuid exits non-zero with UNKNOWN_UUID", async () => {
  const { exitCode, stderr } = await runTasks(["new", "new task", "--deps", "00000000-0000-4000-8000-000000000000"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("UNKNOWN_UUID");
});

// ─── --body - ────────────────────────────────────────────────────────────────

test("tasks new --body - reads body from stdin", async () => {
  const bodyContent = "this is the body from stdin";
  const { exitCode, stdout } = await runTasks(["new", "stdin body task", "--body", "-"], {
    stdin: bodyContent,
  });
  expect(exitCode).toBe(0);
  expect(stdout).toContain("#1");

  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, "backlog")).filter((f) => f.endsWith(".md"));
  const body = readTaskBodyByFilename("backlog", files[0]);
  expect(body).toContain(bodyContent);
});

test("tasks new --body - with empty stdin writes empty body", async () => {
  const { exitCode } = await runTasks(["new", "empty stdin body task", "--body", "-"], {
    stdin: "",
  });
  expect(exitCode).toBe(0);

  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, "backlog")).filter((f) => f.endsWith(".md"));
  const body = readTaskBodyByFilename("backlog", files[0]);
  expect(body.trim()).toBe("");
});

// ─── --edit ──────────────────────────────────────────────────────────────────

test("tasks new --edit opens editor after creation and commits body", async () => {
  const storeDir = getStoreDir();

  // We need the editor to write content that is a valid task file WITH the
  // pre-populated frontmatter. The editor receives the task file after it's
  // already created. We'll use an editor that appends a line to the body.
  // Since we don't know the exact frontmatter in advance, we use a script
  // that appends a known string to the end.
  const editorScript = join(editorScriptDir, "append-editor.sh");
  writeFileSync(
    editorScript,
    `#!/bin/sh\nprintf '\\nbody added by editor' >> "$1"\n`,
    "utf-8",
  );
  chmodSync(editorScript, 0o755);

  const { exitCode } = await runTasks(["new", "task with editor body", "--edit"], {
    extraEnv: { EDITOR: editorScript },
  });
  expect(exitCode).toBe(0);

  const files = readdirSync(join(storeDir, "backlog")).filter((f) => f.endsWith(".md"));
  expect(files).toHaveLength(1);
  const body = readTaskBodyByFilename("backlog", files[0]);
  expect(body).toContain("body added by editor");
});

test("tasks new --edit produces exactly one commit per invocation", async () => {
  const storeDir = getStoreDir();

  // Seed the store with an initial task so the store and its git repo exist
  // and we have a known baseline HEAD to count from.
  await plantTask("seed task");

  const countCommits = async (): Promise<number> => {
    const proc = Bun.spawn(["git", "rev-list", "HEAD", "--count"], {
      cwd: storeDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return parseInt(out.trim(), 10);
  };

  const before = await countCommits();

  // Editor stub that mutates the body so the editor session causes a real change.
  const editorScript = join(editorScriptDir, "append-editor-single-commit.sh");
  writeFileSync(
    editorScript,
    `#!/bin/sh\nprintf '\\nbody added by editor' >> "$1"\n`,
    "utf-8",
  );
  chmodSync(editorScript, 0o755);

  const { exitCode } = await runTasks(["new", "single commit task", "--edit"], {
    extraEnv: { EDITOR: editorScript },
  });
  expect(exitCode).toBe(0);

  const after = await countCommits();
  expect(after - before).toBe(1);
});

test("tasks new --edit with no EDITOR set exits non-zero with NO_EDITOR", async () => {
  const { exitCode, stderr } = await runTasks(["new", "task needs editor", "--edit"], {
    extraEnv: { EDITOR: undefined, VISUAL: undefined },
  });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("NO_EDITOR");
});

test("tasks new --edit with invalid save (cleared title) exits non-zero with INVALID_TITLE", async () => {
  // Editor that clears the title field
  const clearTitleEditor = join(editorScriptDir, "clear-title-editor.sh");
  writeFileSync(
    clearTitleEditor,
    `#!/bin/sh
# Read the file, replace title with empty string, write back
sed 's/^title:.*$/title: ""/' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
`,
    "utf-8",
  );
  chmodSync(clearTitleEditor, 0o755);

  const { exitCode, stderr } = await runTasks(["new", "task with cleared title", "--edit"], {
    extraEnv: { EDITOR: clearTitleEditor },
  });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("INVALID_TITLE");
});

// ─── --edit and --body - mutual exclusion ────────────────────────────────────

test("tasks new --edit and --body - together exit non-zero with clear error", async () => {
  const { exitCode, stderr } = await runTasks(["new", "conflict task", "--edit", "--body", "-"], {
    stdin: "some body",
    extraEnv: { EDITOR: "true" },
  });
  expect(exitCode).not.toBe(0);
  // Should mention some kind of conflict (either CONFLICT or the two flags)
  expect(stderr.length).toBeGreaterThan(0);
});

// ─── combined flags ───────────────────────────────────────────────────────────

test("tasks new --unattended --effort low --deps writes all three to disk", async () => {
  const dep = await plantTask("the dep");

  const { exitCode } = await runTasks([
    "new", "combined flags task",
    "--unattended",
    "--effort", "low",
    "--deps", String(dep.id),
  ]);
  expect(exitCode).toBe(0);

  const storeDir = getStoreDir();
  const files = readdirSync(join(storeDir, "backlog")).filter((f) => f.endsWith(".md")).sort();
  const fm = readTaskFmByFilename("backlog", files[1]);
  expect(fm.attendance).toBe("unattended");
  expect(fm.effort).toBe("low");
  const deps = fm.deps as string[];
  expect(deps).toContain(dep.uuid);
});
