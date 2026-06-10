import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS } from "../src/store.ts";
import { statusForCode } from "../src/serve/server.ts";
import { isIgnoredWatchPath } from "../src/serve/live.ts";

/** Repo root (this file lives in tests/). */
const REPO_ROOT = join(import.meta.dir, "..");
/** Built Vite output that the asset-serving seam reads via TASKS_WEB_DIST. */
const WEB_DIST = join(REPO_ROOT, "web", "dist");

/**
 * Ensure `web/dist` exists for the asset-serving tests. The full prod path
 * (embedded into the compiled binary) is verified manually (see web/README.md)
 * because a `bun build --compile` per test run would be slow/flaky; the seam
 * itself is exercised here against a real Vite build via the TASKS_WEB_DIST
 * affordance (same route/content-type/fallback code path as embedded).
 */
async function ensureWebDist(): Promise<void> {
  if (existsSync(join(WEB_DIST, "index.html"))) return;
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: join(REPO_ROOT, "web"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`web build failed: ${await new Response(proc.stderr).text()}`);
  }
}

let tasksHome: string;
let cwdDir: string;
let cliPath: string;

/** Pinned wall clock so created_at/updated_at fixtures are deterministic. */
const PINNED_NOW = "2026-05-27T10:00:00.000Z";

beforeEach(() => {
  tasksHome = mkdtempSync(join(tmpdir(), "tasks-serve-test-"));
  cwdDir = mkdtempSync(join(tmpdir(), "tasks-serve-cwd-"));
  cliPath = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  rmSync(tasksHome, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

/** Deterministic UUID for a short id (matches the seed convention). */
function depUuid(id: number): string {
  return `${"a".repeat(8)}-${id.toString().padStart(4, "0")}-4000-8000-${"b".repeat(12)}`;
}

interface PlantOpts {
  deps?: number[];
  attendance?: "attended" | "unattended";
  effort?: "low" | "medium" | "high";
  body?: string;
  /** Override created_at (ISO) to control oldest-first ordering. */
  created_at?: string;
}

/** Manually plant a task file into a column directory. */
function plantTask(storeDir: string, column: string, id: number, title: string, opts: PlantOpts = {}): void {
  const colDir = join(storeDir, column);
  mkdirSync(colDir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filename = `${id}-${slug}.md`;
  const created = opts.created_at ?? PINNED_NOW;
  const uuid = depUuid(id);
  const deps = opts.deps ?? [];
  const depsYaml = deps.length === 0 ? "[]" : `[${deps.map((d) => `"${depUuid(d)}"`).join(", ")}]`;
  const attendance = opts.attendance ?? "attended";
  const effort = opts.effort ?? "medium";
  const body = opts.body ?? "";
  const content =
    `---\nid: ${id}\nuuid: ${uuid}\ntitle: ${title}\ndeps: ${depsYaml}\n` +
    `attendance: ${attendance}\neffort: ${effort}\ncreated_at: ${created}\nupdated_at: ${created}\n---\n${body}`;
  writeFileSync(join(colDir, filename), content, "utf-8");
}

/** Initialize a bare store (git repo + meta.yaml) without the CLI. */
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
  await spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
  writeFileSync(join(storeDir, "meta.yaml"), "next_id: 1\n", "utf-8");
  await spawn(["git", "add", "meta.yaml"]);
  await spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "meta"]);
}

/** Commit all currently-planted task files in the store. */
async function commitStore(storeDir: string): Promise<void> {
  const git = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: storeDir, stdout: "pipe", stderr: "pipe" }).exited;
  await git(["add", "."]);
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed tasks"]);
}

/** Count commits on HEAD in the store (to assert "exactly one new commit"). */
async function countCommits(storeDir: string): Promise<number> {
  const proc = Bun.spawn(["git", "rev-list", "--count", "HEAD"], {
    cwd: storeDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return parseInt(out.trim(), 10);
}

/** Derive the store path from tasksHome + encoded cwd. */
function deriveStorePath(tasksHome: string, cwd: string): string {
  const realCwd = realpathSync(cwd);
  const encoded = realCwd.replace(/-/g, "--").replace(/\//g, "-");
  return join(tasksHome, "projects", encoded);
}

/** Run a one-shot CLI command (non-server). */
async function runTasks(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

interface ServerHandle {
  proc: ReturnType<typeof Bun.spawn>;
  baseUrl: string;
  stop: () => void;
}

/**
 * Start `tasks serve` and wait for it to announce its listening URL on stdout.
 * Uses `--port 0` so the OS assigns an ephemeral port (tests run in parallel).
 * The server prints a line containing its base URL on boot.
 */
async function startServe(
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<ServerHandle> {
  const proc = Bun.spawn(["bun", "run", cliPath, "serve", "--port", "0", ...args], {
    env: { ...process.env, TASKS_HOME: tasksHome, TASKS_NOW: PINNED_NOW, ...env },
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwdDir,
  });

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 15000;
  let baseUrl = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const m = buf.match(/https?:\/\/127\.0\.0\.1:(\d+)/);
    if (m) {
      baseUrl = m[0];
      break;
    }
  }
  reader.releaseLock();
  if (!baseUrl) {
    proc.kill();
    throw new Error(`server did not announce a URL; got stdout: ${buf}`);
  }
  return {
    proc,
    baseUrl,
    stop: () => proc.kill(),
  };
}

/**
 * A live reader over an SSE response body. Connect with `openSse`, then
 * `nextEvent()` to await the next parsed `data:` frame (JSON). Always
 * `close()` in a finally so the reader is cancelled and the test process can
 * exit cleanly. `nextEvent` rejects after a bounded timeout so a missed
 * broadcast fails loudly instead of hanging the suite.
 */
interface SseClient {
  nextEvent: (timeoutMs?: number) => Promise<unknown>;
  /**
   * Drain frames until one satisfies `pred`, or the timeout elapses. Models the
   * SSE convergence contract: each frame is a FULL authoritative snapshot, so a
   * client just waits for the frame that reflects the change it expects (an
   * earlier coalesced/stale frame, if any, is harmless and skipped).
   */
  waitFor: (pred: (snap: any) => boolean, timeoutMs?: number) => Promise<any>;
  close: () => Promise<void>;
}

async function openSse(url: string): Promise<{ res: Response; client: SseClient }> {
  const ac = new AbortController();
  const res = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: ac.signal,
  });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // Frames already parsed but not yet consumed by nextEvent.
  const queue: unknown[] = [];

  function drainFrames(): void {
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const rawFrame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = rawFrame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""));
      if (dataLines.length === 0) continue; // comment/keep-alive frame
      queue.push(JSON.parse(dataLines.join("\n")));
    }
  }

  async function nextEvent(timeoutMs = 5000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    if (queue.length > 0) return queue.shift();
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const read = reader.read();
      const timed = new Promise<{ timeout: true }>((resolve) =>
        setTimeout(() => resolve({ timeout: true }), remaining),
      );
      const r = await Promise.race([read, timed]);
      if ("timeout" in r) break;
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      drainFrames();
      if (queue.length > 0) return queue.shift();
    }
    throw new Error("timed out waiting for next SSE event");
  }

  async function waitFor(pred: (snap: any) => boolean, timeoutMs = 8000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = await nextEvent(deadline - Date.now());
      if (pred(snap)) return snap;
    }
    throw new Error("timed out waiting for a matching SSE snapshot");
  }

  async function close(): Promise<void> {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    ac.abort();
  }

  return { res, client: { nextEvent, waitFor, close } };
}

// ─── Behavior 1: no-store refusal ────────────────────────────────────────────

test("tasks serve refuses to start when no store exists: non-zero exit + `tasks init` hint", async () => {
  const { exitCode, stderr } = await runTasks(["serve", "--port", "0"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("tasks init");
});

// ─── Behavior 2: boot + six-lane snapshot, lanes oldest-first ────────────────

test("GET /api/board returns all six lanes; tasks sorted oldest-first (created_at asc)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  // Two backlog tasks: #2 created earlier than #1, so oldest-first puts #2 first.
  plantTask(storeDir, "backlog", 1, "newer", { created_at: "2026-05-27T12:00:00.000Z" });
  plantTask(storeDir, "backlog", 2, "older", { created_at: "2026-05-27T09:00:00.000Z" });
  plantTask(storeDir, "doing", 3, "in progress");
  await commitStore(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/board`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lanes: Record<string, Array<{ id: number }>> };

    for (const col of COLUMNS) {
      expect(body.lanes).toHaveProperty(col);
      expect(Array.isArray(body.lanes[col])).toBe(true);
    }

    // Oldest-first: #2 (09:00) before #1 (12:00).
    expect(body.lanes.backlog.map((t) => t.id)).toEqual([2, 1]);
    expect(body.lanes.doing.map((t) => t.id)).toEqual([3]);
    expect(body.lanes.ready.length).toBe(0);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 3: each task carries the documented fields ─────────────────────

test("each board task exposes id, uuid, title, body, column, effort, attendance, updated_at, blockedBy", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "review", 1, "audit deps", {
    attendance: "unattended",
    effort: "high",
    body: "## Acceptance\n- no CVEs\n",
  });
  await commitStore(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/board`);
    const body = (await res.json()) as { lanes: Record<string, Array<Record<string, unknown>>> };
    const t = body.lanes.review[0];

    expect(t.id).toBe(1);
    expect(typeof t.uuid).toBe("string");
    expect(t.title).toBe("audit deps");
    expect(t.body).toContain("Acceptance");
    expect(t.column).toBe("review");
    expect(t.effort).toBe("high");
    expect(t.attendance).toBe("unattended");
    expect(typeof t.updated_at).toBe("string");
    expect(Array.isArray(t.blockedBy)).toBe(true);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 3b: head info present so the board can show "updated X ago" ─────

test("GET /api/board includes Store HEAD info (sha + committed_at)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/board`);
    const body = (await res.json()) as { head: { sha: string; committed_at: string } | null };
    expect(body.head).not.toBeNull();
    expect(typeof body.head!.sha).toBe("string");
    expect(body.head!.sha.length).toBeGreaterThan(0);
    expect(typeof body.head!.committed_at).toBe("string");
    expect(body.head!.committed_at.length).toBeGreaterThan(0);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 4: blocked-by reflects unresolved blockers ─────────────────────

test("blockedBy lists unresolved direct blockers; resolved (done) deps drop off", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "doing", 1, "dep still open");
  plantTask(storeDir, "done", 2, "dep complete");
  // #3 depends on #1 (open) and #2 (done) -> only #1 is an unresolved blocker.
  plantTask(storeDir, "backlog", 3, "blocked task", { deps: [1, 2] });
  await commitStore(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/board`);
    const body = (await res.json()) as { lanes: Record<string, Array<{ id: number; blockedBy: number[] }>> };
    const t = body.lanes.backlog.find((x) => x.id === 3)!;
    expect(t.blockedBy).toEqual([1]);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 5: archive-aware blocked-by + archive excluded from lanes ───────

test("a task whose only dep is archived shows NO blocked-by entry; archive is excluded from lanes", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  // #1 is archived (Complete). #2 depends only on #1.
  plantTask(storeDir, "archive", 1, "archived dep");
  plantTask(storeDir, "backlog", 2, "depends on archived", { deps: [1] });
  await commitStore(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/board`);
    const body = (await res.json()) as {
      lanes: Record<string, Array<{ id: number; blockedBy: number[] }>>;
    };

    // Archive-satisfied dep is not a blocker.
    const t = body.lanes.backlog.find((x) => x.id === 2)!;
    expect(t.blockedBy).toEqual([]);

    // Archive is not a Column: it must not appear as a lane key, and the
    // archived task #1 must not surface in any lane.
    expect(body.lanes).not.toHaveProperty("archive");
    const allIds = Object.values(body.lanes).flat().map((x) => x.id);
    expect(allIds).not.toContain(1);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 6: core error -> non-2xx envelope, server stays alive ──────────

test("a core error surfaces as HTTP non-2xx with the standard envelope; server stays alive", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);

  const srv = await startServe();
  try {
    // Unknown route -> standard error envelope (code + message), non-2xx.
    const bad = await fetch(`${srv.baseUrl}/api/does-not-exist`);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const errBody = (await bad.json()) as { error?: { code?: string; message?: string } };
    expect(errBody.error).toBeDefined();
    expect(typeof errBody.error!.code).toBe("string");
    expect(typeof errBody.error!.message).toBe("string");

    // Server still serves the board afterwards (it did not exit).
    const ok = await fetch(`${srv.baseUrl}/api/board`);
    expect(ok.status).toBe(200);
    expect(srv.proc.killed).toBe(false);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 6b: statusForCode is the published error-status contract ───────

test("statusForCode maps every documented TasksError code to its HTTP status", () => {
  // 404 — addressing a thing that is not there.
  expect(statusForCode("NOT_FOUND")).toBe(404);
  expect(statusForCode("NOT_INITIALIZED")).toBe(404);
  expect(statusForCode("UNKNOWN_UUID")).toBe(404);
  // 409 — store/state conflict.
  expect(statusForCode("STORE_DIRTY")).toBe(409);
  // 400 — bad input.
  expect(statusForCode("INVALID_TITLE")).toBe(400);
  expect(statusForCode("INVALID_ATTENDANCE")).toBe(400);
  expect(statusForCode("INVALID_EFFORT")).toBe(400);
  expect(statusForCode("INVALID_COLUMN")).toBe(400);
  expect(statusForCode("INVALID_SINCE")).toBe(400);
  // 503 — environment can't satisfy the request right now.
  expect(statusForCode("FLOCK_MISSING")).toBe(503);
  // unknown / unmapped code -> generic 500.
  expect(statusForCode("SOMETHING_ELSE")).toBe(500);
});

// ─── Behavior 6c: --port is validated, never silently random ─────────────────

test("tasks serve --port abc fails fast on stderr and does not start a server", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  await commitStore(storeDir);

  const { exitCode, stdout, stderr } = await runTasks(["serve", "--port", "abc"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("--port");
  // It must NOT have started a server (no listening-URL announcement).
  expect(stdout).not.toMatch(/https?:\/\/127\.0\.0\.1:\d+/);
});

// ─── Behavior 7: binds to 127.0.0.1 only ─────────────────────────────────────

test("server binds to 127.0.0.1 and is reachable there", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  await commitStore(storeDir);

  const srv = await startServe();
  try {
    expect(srv.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${srv.baseUrl}/api/board`);
    expect(res.status).toBe(200);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 8: POST /api/tasks/:id/move performs a Transition ──────────────

test("POST /api/tasks/:id/move relocates the task in exactly one commit; survives /api/board re-read", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/tasks/1/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "doing" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number; from: string; to: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(1);
    expect(body.from).toBe("backlog");
    expect(body.to).toBe("doing");

    // Exactly one new commit (same as `tasks mv`).
    expect(await countCommits(storeDir)).toBe(before + 1);

    // Survives a re-read of the board: task #1 is now in `doing`, gone from backlog.
    const boardRes = await fetch(`${srv.baseUrl}/api/board`);
    const board = (await boardRes.json()) as { lanes: Record<string, Array<{ id: number }>> };
    expect(board.lanes.doing.map((t) => t.id)).toContain(1);
    expect(board.lanes.backlog.map((t) => t.id)).not.toContain(1);
  } finally {
    srv.stop();
  }
});

test("POST /api/tasks/:id/move with an unknown id returns NOT_FOUND + non-2xx, no commit", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/tasks/999/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "doing" }),
    });
    expect(res.status).toBe(statusForCode("NOT_FOUND"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("NOT_FOUND");
    expect(await countCommits(storeDir)).toBe(before);
  } finally {
    srv.stop();
  }
});

test("POST /api/tasks/:id/move with an invalid column returns INVALID_COLUMN + non-2xx, no commit", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/tasks/1/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "nonsense" }),
    });
    expect(res.status).toBe(statusForCode("INVALID_COLUMN"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_COLUMN");
    expect(await countCommits(storeDir)).toBe(before);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 9: POST /api/tasks creates a Task in backlog ───────────────────

test("POST /api/tasks lands a new Task in backlog/ with the given effort in exactly one commit; appears in next /api/board", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "brand new task", body: "## Acceptance\n- done\n", effort: "high" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; id: number; uuid: string; column: string };
    expect(body.ok).toBe(true);
    // Fresh Short ID allocated from meta.yaml (next_id started at 1).
    expect(body.id).toBe(1);
    expect(typeof body.uuid).toBe("string");
    expect(body.uuid.length).toBeGreaterThan(0);
    expect(body.column).toBe("backlog");

    // Exactly one new commit (same single-commit invariant as `tasks new`).
    expect(await countCommits(storeDir)).toBe(before + 1);

    // The file landed in backlog/ on disk.
    const files = (await Bun.$`ls ${join(storeDir, "backlog")}`.text()).trim().split(/\s+/);
    expect(files.some((f) => f.startsWith(`${body.id}-`) && f.endsWith(".md"))).toBe(true);

    // Appears in the next board snapshot, in backlog, with the given effort.
    const boardRes = await fetch(`${srv.baseUrl}/api/board`);
    const board = (await boardRes.json()) as {
      lanes: Record<string, Array<{ id: number; title: string; effort: string; attendance: string }>>;
    };
    const created = board.lanes.backlog.find((t) => t.id === body.id)!;
    expect(created).toBeDefined();
    expect(created.title).toBe("brand new task");
    expect(created.effort).toBe("high");
    expect(created.attendance).toBe("attended");
  } finally {
    srv.stop();
  }
});

test("POST /api/tasks with missing/empty title is rejected with INVALID_TITLE + non-2xx, no commit", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const srv = await startServe();
  try {
    for (const payload of [{}, { title: "" }, { title: "   " }]) {
      const res = await fetch(`${srv.baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(statusForCode("INVALID_TITLE"));
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("INVALID_TITLE");
    }
    // No task was created: commit count is unchanged.
    expect(await countCommits(storeDir)).toBe(before);
  } finally {
    srv.stop();
  }
});

test("POST /api/tasks/:id/move into doing succeeds even with an unresolved blocker (open transitions)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  // #2 depends on #1; #1 is still in backlog, so #2 is blocked.
  plantTask(storeDir, "backlog", 1, "blocker");
  plantTask(storeDir, "backlog", 2, "blocked task", { deps: [1] });
  await commitStore(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/tasks/2/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "doing" }),
    });
    expect(res.status).toBe(200);

    const boardRes = await fetch(`${srv.baseUrl}/api/board`);
    const board = (await boardRes.json()) as {
      lanes: Record<string, Array<{ id: number; blockedBy: unknown[] }>>;
    };
    const moved = board.lanes.doing.find((t) => t.id === 2);
    expect(moved).toBeDefined();
    // Still reported as blocked: the transition did not require resolution.
    expect(moved!.blockedBy.length).toBeGreaterThan(0);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 10: PATCH /api/tasks/:id edits title/effort/attendance ──────────

/** A wall clock later than PINNED_NOW, so an updated_at bump is observable. */
const LATER_NOW = "2026-05-28T10:00:00.000Z";

test("PATCH /api/tasks/:id edits title, effort, attendance in one commit; bumps updated_at; reflected in board", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "old title", { effort: "low", attendance: "attended" });
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const srv = await startServe([], { TASKS_NOW: LATER_NOW });
  try {
    const res = await fetch(`${srv.baseUrl}/api/tasks/1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "new title", effort: "high", attendance: "unattended" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number; uuid: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(1);
    expect(typeof body.uuid).toBe("string");

    expect(await countCommits(storeDir)).toBe(before + 1);

    const boardRes = await fetch(`${srv.baseUrl}/api/board`);
    const board = (await boardRes.json()) as {
      lanes: Record<string, Array<{ id: number; title: string; effort: string; attendance: string; updated_at: string }>>;
    };
    const edited = board.lanes.backlog.find((t) => t.id === 1)!;
    expect(edited).toBeDefined();
    expect(edited.title).toBe("new title");
    expect(edited.effort).toBe("high");
    expect(edited.attendance).toBe("unattended");
    expect(edited.updated_at).toBe(LATER_NOW);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 11: PATCH body edit through the new programmatic core path ──────

test("PATCH /api/tasks/:id replaces body via the new core path in one commit; round-trips on-disk and via board", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task", { body: "old body\n" });
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const newBody = "## Acceptance\n- one\n- two\n";

  const srv = await startServe([], { TASKS_NOW: LATER_NOW });
  try {
    const res = await fetch(`${srv.baseUrl}/api/tasks/1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: newBody }),
    });
    expect(res.status).toBe(200);

    // Exactly one new commit.
    expect(await countCommits(storeDir)).toBe(before + 1);

    // Round-trips via the board (same parse convention as create/list).
    const boardRes = await fetch(`${srv.baseUrl}/api/board`);
    const board = (await boardRes.json()) as {
      lanes: Record<string, Array<{ id: number; body: string; updated_at: string }>>;
    };
    const edited = board.lanes.backlog.find((t) => t.id === 1)!;
    expect(edited).toBeDefined();
    expect(edited.body).toBe(newBody);
    expect(edited.updated_at).toBe(LATER_NOW);

    // Round-trips on-disk: the file contains the new body verbatim after the
    // closing frontmatter delimiter (one leading newline, matching `new`).
    const files = (await Bun.$`ls ${join(storeDir, "backlog")}`.text()).trim().split(/\s+/);
    const raw = await Bun.file(join(storeDir, "backlog", files[0]!)).text();
    expect(raw.endsWith(`---\n${newBody}`)).toBe(true);
  } finally {
    srv.stop();
  }
});

test("PATCH /api/tasks/:id round-trips bodies containing Markdown --- horizontal rules verbatim", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "hr task");
  plantTask(storeDir, "backlog", 2, "fence task");
  plantTask(storeDir, "backlog", 3, "bare rule task");
  await commitStore(storeDir);

  // 1) A normal Markdown horizontal rule between two paragraphs.
  const hrBody = "Steps\n\n---\n\nDone\n";
  // 2) A fenced code block whose content has a `---` line.
  const fenceBody = "```yaml\nfoo: bar\n---\nbaz: qux\n```\n";
  // 3) A body that is exactly a bare horizontal rule.
  const bareBody = "---\n";

  const srv = await startServe([], { TASKS_NOW: LATER_NOW });
  try {
    const cases: Array<[number, string]> = [
      [1, hrBody],
      [2, fenceBody],
      [3, bareBody],
    ];
    for (const [id, body] of cases) {
      const res = await fetch(`${srv.baseUrl}/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      expect(res.status).toBe(200);
    }

    const boardRes = await fetch(`${srv.baseUrl}/api/board`);
    const board = (await boardRes.json()) as {
      lanes: Record<string, Array<{ id: number; body: string }>>;
    };
    for (const [id, body] of cases) {
      const t = board.lanes.backlog.find((x) => x.id === id)!;
      expect(t).toBeDefined();
      // Byte-for-byte identical: no swallowed newlines, no body split on ---.
      expect(t.body).toBe(body);
    }
  } finally {
    srv.stop();
  }
});

// ─── Behavior 12: PATCH validation — effort/attendance/title/empty ────────────

test("PATCH /api/tasks/:id rejects invalid effort/attendance with correct codes + non-2xx, no commit", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const srv = await startServe();
  try {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ effort: "huge" }, "INVALID_EFFORT"],
      [{ attendance: "maybe" }, "INVALID_ATTENDANCE"],
    ];
    for (const [payload, code] of cases) {
      const res = await fetch(`${srv.baseUrl}/api/tasks/1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(statusForCode(code));
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe(code);
    }
    expect(await countCommits(storeDir)).toBe(before);
  } finally {
    srv.stop();
  }
});

test("PATCH /api/tasks/:id enforces title validation via the Validator (empty/multiline) + no commit", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const srv = await startServe();
  try {
    for (const title of ["", "   ", "line one\nline two"]) {
      const res = await fetch(`${srv.baseUrl}/api/tasks/1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(statusForCode("INVALID_TITLE"));
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("INVALID_TITLE");
    }
    expect(await countCommits(storeDir)).toBe(before);
  } finally {
    srv.stop();
  }
});

test("PATCH /api/tasks/:id with no editable field is rejected with MISSING_FIELD + no commit", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/tasks/1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "doing" }),
    });
    expect(res.status).toBe(statusForCode("MISSING_FIELD"));
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("MISSING_FIELD");
    expect(await countCommits(storeDir)).toBe(before);
  } finally {
    srv.stop();
  }
});

// ─── Behavior 13: GET /api/events SSE live sync (issue #17) ───────────────────

test("GET /api/events streams text/event-stream and pushes a fresh snapshot on an out-of-band `tasks mv`", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);

  const srv = await startServe();
  const { res, client } = await openSse(`${srv.baseUrl}/api/events`);
  try {
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");

    // The server sends an initial snapshot on connect: task #1 in backlog.
    const initial = (await client.nextEvent()) as {
      lanes: Record<string, Array<{ id: number }>>;
    };
    expect(initial.lanes.backlog.map((t) => t.id)).toEqual([1]);
    expect(initial.lanes.doing.map((t) => t.id)).toEqual([]);

    // Out-of-band mutation from a SEPARATE process — no HTTP read against the
    // server triggers this. The watcher must observe the commit and rebroadcast.
    const mv = await runTasks(["mv", "1", "doing"]);
    expect(mv.exitCode).toBe(0);

    // Converge: the stream pushes the full snapshot reflecting the move. (The
    // snapshot is authoritative every tick, so we wait for the frame that shows
    // #1 in doing rather than assuming the first post-mv frame is final.)
    const update = await client.waitFor(
      (s) => s.lanes.doing.some((t: { id: number }) => t.id === 1),
    );
    expect(update.lanes.doing.map((t: { id: number }) => t.id)).toEqual([1]);
    expect(update.lanes.backlog.map((t: { id: number }) => t.id)).toEqual([]);
  } finally {
    await client.close();
    srv.stop();
  }
});

test("GET /api/events fans the same update out to every connected client", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);

  const srv = await startServe();
  const a = await openSse(`${srv.baseUrl}/api/events`);
  const b = await openSse(`${srv.baseUrl}/api/events`);
  try {
    // Both connected; drain each initial frame.
    await a.client.nextEvent();
    await b.client.nextEvent();

    await runTasks(["mv", "1", "doing"]);

    const inDoing = (s: any) => s.lanes.doing.some((t: { id: number }) => t.id === 1);
    const ua = await a.client.waitFor(inDoing);
    const ub = await b.client.waitFor(inDoing);
    expect(ua.lanes.doing.map((t: { id: number }) => t.id)).toEqual([1]);
    expect(ub.lanes.doing.map((t: { id: number }) => t.id)).toEqual([1]);
  } finally {
    await a.client.close();
    await b.client.close();
    srv.stop();
  }
});

test("GET /api/events: rapid successive commits converge — the final correct snapshot is delivered", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);

  const srv = await startServe();
  const { client } = await openSse(`${srv.baseUrl}/api/events`);
  try {
    await client.nextEvent(); // initial

    // Three successive moves (each its own commit) in quick succession. The
    // debounce may coalesce broadcasts, but the FINAL state (#1 in done) must
    // arrive — convergence, not a missed terminal state.
    expect((await runTasks(["mv", "1", "doing"])).exitCode).toBe(0);
    expect((await runTasks(["mv", "1", "review"])).exitCode).toBe(0);
    expect((await runTasks(["mv", "1", "done"])).exitCode).toBe(0);

    const final = await client.waitFor(
      (s) => s.lanes.done.some((t: { id: number }) => t.id === 1),
    );
    expect(final.lanes.done.map((t: { id: number }) => t.id)).toEqual([1]);
    // #1 is in done only — not lingering in any earlier lane.
    expect(final.lanes.backlog.map((t: { id: number }) => t.id)).toEqual([]);
    expect(final.lanes.doing.map((t: { id: number }) => t.id)).toEqual([]);
    expect(final.lanes.review.map((t: { id: number }) => t.id)).toEqual([]);
  } finally {
    await client.close();
    srv.stop();
  }
});

test("isIgnoredWatchPath drops git/lock churn but keeps real Column changes (so .git housekeeping never spams broadcasts)", () => {
  // Ignored: git internals + the flock file + null paths.
  expect(isIgnoredWatchPath(".git")).toBe(true);
  expect(isIgnoredWatchPath(".git/index")).toBe(true);
  expect(isIgnoredWatchPath(".git/objects/ab/cdef")).toBe(true);
  expect(isIgnoredWatchPath(".git/refs/heads/main")).toBe(true);
  expect(isIgnoredWatchPath(".tasks-lock")).toBe(true);
  expect(isIgnoredWatchPath(null)).toBe(true);

  // Kept: a Column-dir change is exactly what should trigger a rebroadcast.
  expect(isIgnoredWatchPath("backlog/1-a-task.md")).toBe(false);
  expect(isIgnoredWatchPath("doing/1-a-task.md")).toBe(false);
  expect(isIgnoredWatchPath("archive/9-old.md")).toBe(false);
  expect(isIgnoredWatchPath("meta.yaml")).toBe(false);
  // Not a false positive on a name that merely starts with the git prefix.
  expect(isIgnoredWatchPath(".gitignore")).toBe(false);
});

test("GET /api/events: a disconnected client is dropped cleanly — later mv still broadcasts to survivors, no error", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);

  const srv = await startServe();
  const dropped = await openSse(`${srv.baseUrl}/api/events`);
  const survivor = await openSse(`${srv.baseUrl}/api/events`);
  try {
    await dropped.client.nextEvent();
    await survivor.client.nextEvent();

    // First client disconnects (cancels its stream). The server must remove its
    // controller; a later broadcast must NOT throw writing to the dead one.
    await dropped.client.close();
    // Give the cancel() callback a beat to run on the server side.
    await runTasks(["mv", "1", "doing"]);

    // The survivor still converges — proves the broadcast loop didn't blow up on
    // the dead controller and the shared watcher is still alive.
    const update = await survivor.client.waitFor(
      (s) => s.lanes.doing.some((t: { id: number }) => t.id === 1),
    );
    expect(update.lanes.doing.map((t: { id: number }) => t.id)).toEqual([1]);

    // Server is still alive and serving (it never crashed on the dead write).
    const ok = await fetch(`${srv.baseUrl}/api/board`);
    expect(ok.status).toBe(200);
    expect(srv.proc.killed).toBe(false);
  } finally {
    await survivor.client.close();
    srv.stop();
  }
});

test("GET /api/events: last client leaving and a new one joining still works (watcher teardown + restart)", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);

  const srv = await startServe();
  try {
    // First client connects then leaves — the LAST client leaving tears the
    // watcher down. A fresh client must transparently restart it and still get
    // live updates (no leaked-but-dead watcher state).
    const first = await openSse(`${srv.baseUrl}/api/events`);
    await first.client.nextEvent();
    await first.client.close();

    const second = await openSse(`${srv.baseUrl}/api/events`);
    try {
      await second.client.nextEvent();
      await runTasks(["mv", "1", "doing"]);
      const update = await second.client.waitFor(
        (s) => s.lanes.doing.some((t: { id: number }) => t.id === 1),
      );
      expect(update.lanes.doing.map((t: { id: number }) => t.id)).toEqual([1]);
    } finally {
      await second.client.close();
    }
  } finally {
    srv.stop();
  }
});

test("PATCH /api/tasks/:id with an unknown id returns NOT_FOUND + non-2xx, no commit", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "backlog", 1, "a task");
  await commitStore(storeDir);
  const before = await countCommits(storeDir);

  const srv = await startServe();
  try {
    const res = await fetch(`${srv.baseUrl}/api/tasks/999`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(statusForCode("NOT_FOUND"));
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("NOT_FOUND");
    expect(await countCommits(storeDir)).toBe(before);
  } finally {
    srv.stop();
  }
});

// ─── Asset-serving seam (issue #25) ──────────────────────────────────────────
//
// In dev there are no embedded assets (Vite fronts the UI and proxies /api), so
// `serve` serves API only. In the compiled binary the built SPA is embedded and
// served on every non-/api route. These tests exercise the seam against a real
// Vite build via TASKS_WEB_DIST, which runs the SAME code path as embedded.

test("with built assets present: GET / returns the SPA shell as text/html", async () => {
  await ensureWebDist();
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  await commitStore(storeDir);

  const srv = await startServe([], { TASKS_WEB_DIST: WEB_DIST });
  try {
    const res = await fetch(`${srv.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    // The shell references a hashed JS bundle (proves it's the built output).
    expect(html).toMatch(/\/assets\/index-[\w-]+\.js/);
  } finally {
    srv.stop();
  }
});

test("with built assets present: GET /assets/<hashed>.js and .css serve with correct content-type", async () => {
  await ensureWebDist();
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  await commitStore(storeDir);

  const assetNames = readdirSync(join(WEB_DIST, "assets"));
  const jsName = assetNames.find((n) => n.endsWith(".js"))!;
  const cssName = assetNames.find((n) => n.endsWith(".css"))!;

  const srv = await startServe([], { TASKS_WEB_DIST: WEB_DIST });
  try {
    const js = await fetch(`${srv.baseUrl}/assets/${jsName}`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type") ?? "").toContain("javascript");
    expect((await js.text()).length).toBeGreaterThan(0);

    const css = await fetch(`${srv.baseUrl}/assets/${cssName}`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type") ?? "").toContain("text/css");
  } finally {
    srv.stop();
  }
});

test("with built assets present: unknown non-/api route falls back to index.html (SPA)", async () => {
  await ensureWebDist();
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  await commitStore(storeDir);

  const srv = await startServe([], { TASKS_WEB_DIST: WEB_DIST });
  try {
    const res = await fetch(`${srv.baseUrl}/board/some/deep/client-route`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain('<div id="root"></div>');
  } finally {
    srv.stop();
  }
});

test("with built assets present: a missing /assets/<file> 404s (not SPA-fallen-back)", async () => {
  await ensureWebDist();
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  await commitStore(storeDir);

  const srv = await startServe([], { TASKS_WEB_DIST: WEB_DIST });
  try {
    const res = await fetch(`${srv.baseUrl}/assets/does-not-exist-abc123.js`);
    expect(res.status).toBe(404);
  } finally {
    srv.stop();
  }
});

test("with built assets present: /api/* still behaves (board JSON), not the SPA shell", async () => {
  await ensureWebDist();
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  plantTask(storeDir, "doing", 1, "wired");
  await commitStore(storeDir);

  const srv = await startServe([], { TASKS_WEB_DIST: WEB_DIST });
  try {
    const res = await fetch(`${srv.baseUrl}/api/board`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = (await res.json()) as { lanes: Record<string, Array<{ id: number }>> };
    expect(body.lanes.doing.map((t) => t.id)).toEqual([1]);
  } finally {
    srv.stop();
  }
});

test("without built assets (dev): unknown non-/api route 404s and /api still works", async () => {
  const storeDir = deriveStorePath(tasksHome, cwdDir);
  await initBareStore(storeDir);
  await commitStore(storeDir);

  // No TASKS_WEB_DIST and running from source => no embedded assets (dev mode).
  const srv = await startServe();
  try {
    const root = await fetch(`${srv.baseUrl}/`);
    expect(root.status).toBe(404);

    const api = await fetch(`${srv.baseUrl}/api/board`);
    expect(api.status).toBe(200);
  } finally {
    srv.stop();
  }
});
