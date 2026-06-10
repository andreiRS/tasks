import {
  COLUMNS,
  EFFORT_VALUES,
  createTask,
  findAllTasks,
  findArchivedTasks,
  findTask,
  moveTask,
  setTask,
  TasksError,
  validateTitle,
} from "../store.ts";
import { computeBlockedBy } from "../render.ts";
import { buildBoardSnapshot, type BoardSnapshot } from "./snapshot.ts";
import { createLiveSync } from "./live.ts";
import { loadAssets, contentTypeFor, type AssetBundle } from "./assets.ts";

export interface ServeOptions {
  dir: string;
  port: number;
}

/**
 * Shown when `serve` has no web UI to host (a source run with no built web/dist,
 * and no embedded SPA). The board API is up, so we explain the two ways to get
 * the UI rather than 404 the browser. Kept inline (no asset dependency — the
 * whole point is that assets are missing) and deliberately tiny.
 */
const NO_UI_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>tasks board — UI not built</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  code { background: #f1f1f1; padding: .15em .4em; border-radius: 4px; }
  h1 { font-size: 1.4rem; } .ok { color: #137333; }
</style></head>
<body>
  <h1>The board API is running, but the web UI isn’t built yet</h1>
  <p>You reached <code>tasks serve</code>, but it has no web interface to show in this run.
     The JSON API under <code>/api</code> is live — for example
     <a href="/api/board">/api/board</a> works.</p>
  <p>To see the visual board, pick one:</p>
  <ul>
    <li><strong>Build the web UI once</strong>, then restart <code>tasks serve</code> — it auto-serves
        the built <code>web/dist</code> from source:<br><code>bun run build:web</code></li>
    <li><strong>Use the compiled binary</strong> (self-contained, UI embedded):<br>
        <code>bun run build:binary</code> then <code>./dist/tasks serve</code></li>
  </ul>
  <p class="ok">Then refresh this page.</p>
</body>
</html>
`;

/** One-line boot warning (stderr) mirroring the guidance page, so the fix is
 *  visible in the terminal too, not only in the browser. */
const NO_UI_WARNING =
  "tasks serve: no web UI found — serving the JSON API only. " +
  "Run `bun run build:web` (then restart) to serve the board from web/dist, " +
  "or use the compiled binary: `bun run build:binary` then ./dist/tasks serve.\n";

/**
 * Boot the localhost-only board HTTP server. Binds to 127.0.0.1 (no remote
 * exposure, no auth — single-user assumption, see ADR-0016). Announces its
 * listening URL on stdout so callers (and the test harness) can discover the
 * assigned port when `--port 0` is used.
 *
 * Reuses the core in-process. Request handlers map any thrown `TasksError`
 * to the standard HTTP error envelope and NEVER call `process.exit`, so a
 * core error returns a non-2xx response while the server stays alive.
 */
export async function startBoardServer(opts: ServeOptions): Promise<ReturnType<typeof Bun.serve>> {
  const { dir } = opts;

  // Live sync (issue #17 / decision #24): a single shared fs.watch on the Store
  // root, debounced and `.git`/lock-filtered, rebroadcasts the full board
  // snapshot to every connected SSE client. See src/serve/live.ts. We pass
  // `readSnapshot` so SSE frames are byte-identical to a GET /api/board read.
  // TASKS_SSE_HEARTBEAT_MS overrides the keep-alive cadence (test seam; a tiny
  // value lets a test observe the heartbeat without waiting the 15s default).
  const heartbeatMs = parseHeartbeatMs(process.env.TASKS_SSE_HEARTBEAT_MS);
  const { handleEvents } =
    heartbeatMs === undefined
      ? createLiveSync(dir, readSnapshot)
      : createLiveSync(dir, readSnapshot, heartbeatMs);

  // Asset-serving seam (issue #25, see src/serve/assets.ts): the compiled binary
  // serves its embedded SPA; a source run serves a locally-built web/dist when
  // present. When neither exists we have no UI to host — warn loudly at boot so a
  // user who opened the board URL and got the guidance page knows the one-line
  // fix, instead of staring at a bare JSON 404. Resolved once at boot.
  const assets = await loadAssets();
  if (!assets) {
    process.stderr.write(NO_UI_WARNING);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/board") {
        return handleBoard(dir);
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        // Disable Bun's idle timeout for THIS streaming request (default 10s):
        // an SSE stream is quiet between board mutations, so the default would
        // close it mid-response after 10s of no bytes — the real cause of the
        // "live updates stop until refresh" stall (it killed direct AND proxied
        // connections, not the Vite proxy as previously thought). Per-request so
        // normal POST/GET handlers keep the 10s guard against a hung request.
        server.timeout(req, 0);
        return handleEvents();
      }
      if (req.method === "POST" && url.pathname === "/api/tasks") {
        return handleCreate(dir, req);
      }
      const moveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/move$/);
      if (req.method === "POST" && moveMatch) {
        return handleMove(dir, decodeURIComponent(moveMatch[1]!), req);
      }
      const editMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === "PATCH" && editMatch) {
        return handleEdit(dir, decodeURIComponent(editMatch[1]!), req);
      }

      // Non-API routes: serve the SPA when assets are present (prod binary or a
      // source run with a built web/dist). ANY path whose first segment is `api`
      // (bare `/api` AND `/api/...`) is the API namespace and must fall through to
      // the JSON NOT_FOUND envelope below, NEVER the SPA shell — a 200 text/html
      // where JSON was expected hides bugs. (A bare `/api` previously slipped past
      // a `startsWith('/api/')`-only guard.)
      if (!isApiNamespace(url.pathname) && req.method === "GET") {
        // No UI to serve: hand back a small guidance page (how to enable the
        // board) rather than the JSON NOT_FOUND envelope, which reads as a broken
        // server to anyone who just opened the board URL in a browser.
        if (!assets) {
          return new Response(NO_UI_HTML, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return serveAsset(assets, url.pathname);
      }

      // Route the 404 through the single envelope path (errorResponse) so there
      // is exactly one place that builds the error shape + picks the status.
      return errorResponse(new TasksError("NOT_FOUND", "no such route", { path: url.pathname }));
    },
  });

  process.stdout.write(`tasks board listening on http://127.0.0.1:${server.port}\n`);
  return server;
}

/** Parse the TASKS_SSE_HEARTBEAT_MS override. Returns undefined (use the
 *  built-in default) for an unset or non-numeric value; a finite >= 0 number is
 *  honored verbatim (0 disables the heartbeat). */
function parseHeartbeatMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Assemble the full board snapshot from the Store on disk. Single source of
 * truth shared by GET /api/board and the SSE broadcast, so an SSE frame is
 * byte-identical to a board read.
 *
 * Archived deps count as Complete, so feed live + archived into the blocker
 * computation; archive itself is excluded from the lanes by buildBoardSnapshot
 * (it only groups live tasks).
 */
function readSnapshot(dir: string): BoardSnapshot {
  const liveTasks = findAllTasks(dir);
  const archivedTasks = findArchivedTasks(dir);
  const blockedBy = computeBlockedBy([...liveTasks, ...archivedTasks]);
  return buildBoardSnapshot(dir, liveTasks, blockedBy);
}

/** GET /api/board — the six-lane board snapshot. */
function handleBoard(dir: string): Response {
  try {
    return jsonResponse(readSnapshot(dir), 200);
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/tasks/:id/move — perform a Transition by reusing the `moveTask`
 * core (same flock -> dirty-guard -> Validator -> commit path as `tasks mv`).
 *
 * Contract:
 *   - `:id` is the Short ID (also accepts a UUID, same as `tasks mv`).
 *   - request body is JSON `{ "column": "<target>" }`.
 *   - success: 200 `{ ok, id, uuid, from, to }`. The frontend reconciles the
 *     full task from the board/SSE, so we return just enough to confirm.
 *   - unknown id: NOT_FOUND (404, from the core). Invalid column: INVALID_COLUMN
 *     (400, validated here before the mutation, mirroring `tasks mv`).
 *   - all transitions are legal (ADR-0005): a still-blocked task may move into
 *     any Column including `doing`/`done`.
 */
async function handleMove(dir: string, id: string, req: Request): Promise<Response> {
  try {
    let column: unknown;
    try {
      const parsed = (await req.json()) as { column?: unknown };
      column = parsed?.column;
    } catch {
      throw new TasksError("MISSING_FIELD", "request body must be JSON with a `column` field", {});
    }
    if (typeof column !== "string" || column.length === 0) {
      throw new TasksError("MISSING_FIELD", "`column` is required", { field: "column" });
    }
    if (!COLUMNS.includes(column)) {
      throw new TasksError("INVALID_COLUMN", `unknown column: ${column}. Valid columns: ${COLUMNS.join(", ")}`, {
        column,
        valid: COLUMNS,
      });
    }

    // Capture the source column before the move so the response can report it.
    // If the task is unknown, moveTask throws NOT_FOUND below (single source of truth).
    const before = findTask(dir, id);
    await moveTask(dir, id, column);

    return jsonResponse(
      { ok: true, id: before?.id ?? null, uuid: before?.uuid ?? null, from: before?.column ?? null, to: column },
      200,
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/tasks — create a Task by reusing the `createTask` core (same
 * flock -> dirty-guard -> validate -> write -> commit path as `tasks new`).
 *
 * Contract (field names chosen so #16 edit + #21 modal can reuse them):
 *   - request body is JSON `{ title, body?, effort? }`.
 *     - `title` is required, non-empty (validateTitle rules, shared with `new`).
 *     - `body` is optional markdown (acceptance criteria etc.).
 *     - `effort` is optional, one of low/medium/high; defaults to the core
 *       DEFAULT_EFFORT (`medium`), exactly like `tasks new`.
 *   - attendance defaults to `attended` and the task lands in `backlog`, set
 *     by the core (we pass neither, so the core applies its defaults).
 *   - success: 201 `{ ok, id, uuid, column }`. Lean by design — the frontend
 *     reconciles the full task from the next board/SSE read; we return just the
 *     fresh Short ID + uuid so the #21 modal can react.
 *   - missing/empty title: INVALID_TITLE (400). Invalid effort: INVALID_EFFORT
 *     (400). Both validated here before the mutation, mirroring `tasks new`.
 */
async function handleCreate(dir: string, req: Request): Promise<Response> {
  try {
    let parsed: { title?: unknown; body?: unknown; effort?: unknown };
    try {
      parsed = (await req.json()) as typeof parsed;
    } catch {
      throw new TasksError("MISSING_FIELD", "request body must be JSON with a `title` field", {});
    }

    const titleError = validateTitle(parsed?.title);
    if (titleError !== null) {
      throw new TasksError("INVALID_TITLE", titleError, {});
    }
    const title = parsed.title as string;

    let effort: "low" | "medium" | "high" | undefined;
    if (parsed.effort !== undefined) {
      if (typeof parsed.effort !== "string" || !(EFFORT_VALUES as readonly string[]).includes(parsed.effort)) {
        throw new TasksError("INVALID_EFFORT", `invalid effort value: ${String(parsed.effort)}. Allowed: ${EFFORT_VALUES.join(", ")}`, {
          value: parsed.effort,
          allowed: [...EFFORT_VALUES],
        });
      }
      effort = parsed.effort as "low" | "medium" | "high";
    }

    let body: string | undefined;
    if (parsed.body !== undefined) {
      if (typeof parsed.body !== "string") {
        throw new TasksError("MISSING_FIELD", "`body` must be a string", { field: "body" });
      }
      body = parsed.body;
    }

    const id = await createTask(dir, title, { effort, body });
    const created = findTask(dir, String(id));

    return jsonResponse({ ok: true, id, uuid: created?.uuid ?? null, column: "backlog" }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/tasks/:id — edit a Task's title / body / effort / attendance (any
 * subset) by reusing the `setTask` core (same flock -> dirty-guard -> Validator
 * -> commit path as `tasks set`). Body editing uses the new programmatic core
 * path added in this slice (SetTaskOptions.body + TaskFile.setBody).
 *
 * Contract (field names shared with #15 create; `attendance` added here):
 *   - `:id` is the Short ID (also accepts a UUID, URL-decoded — same as move).
 *   - request body is JSON `{ title?, body?, effort?, attendance? }`; any subset.
 *     - Column is NOT editable here (use the move endpoint); deps stay CLI-only.
 *     - `title`: validated by the core Validator (non-empty, single line, max len).
 *     - `body`: arbitrary markdown string, replaces the task body verbatim.
 *     - `effort`: one of low/medium/high. `attendance`: attended/unattended.
 *   - empty PATCH (no editable field present) is rejected with MISSING_FIELD
 *     (400): a no-op commit would violate the one-commit-per-edit invariant and
 *     hide a client bug, so we refuse loudly.
 *   - success: 200 `{ ok, id, uuid }`. Lean by design — the frontend reconciles
 *     the full task from the next board/SSE read (mirrors move/create).
 *   - unknown id: NOT_FOUND (404, from the core). Invalid effort/attendance:
 *     INVALID_EFFORT / INVALID_ATTENDANCE (400). Invalid title: INVALID_TITLE
 *     (400). All enforced by the core via setTask.
 */
async function handleEdit(dir: string, id: string, req: Request): Promise<Response> {
  try {
    let parsed: { title?: unknown; body?: unknown; effort?: unknown; attendance?: unknown };
    try {
      parsed = (await req.json()) as typeof parsed;
    } catch {
      throw new TasksError("MISSING_FIELD", "request body must be JSON", {});
    }

    const opts: { title?: string; body?: string; effort?: "low" | "medium" | "high"; attendance?: "attended" | "unattended" } = {};

    if (parsed.title !== undefined) {
      if (typeof parsed.title !== "string") {
        throw new TasksError("INVALID_TITLE", "`title` must be a string", { field: "title" });
      }
      opts.title = parsed.title;
    }
    if (parsed.body !== undefined) {
      if (typeof parsed.body !== "string") {
        throw new TasksError("MISSING_FIELD", "`body` must be a string", { field: "body" });
      }
      opts.body = parsed.body;
    }
    if (parsed.effort !== undefined) {
      // Enum membership (and non-string shape) is enforced by the core setTask,
      // which throws INVALID_EFFORT with the same {value, allowed} details.
      opts.effort = parsed.effort as "low" | "medium" | "high";
    }
    if (parsed.attendance !== undefined) {
      // Enum membership (and non-string shape) is enforced by the core setTask,
      // which throws INVALID_ATTENDANCE with the same {value, allowed} details.
      opts.attendance = parsed.attendance as "attended" | "unattended";
    }

    if (Object.keys(opts).length === 0) {
      throw new TasksError("MISSING_FIELD", "no editable field supplied (title, body, effort, attendance)", {});
    }

    // Resolve the task first so the response can report id/uuid; the core
    // re-resolves and is the single source of truth for NOT_FOUND.
    const before = findTask(dir, id);
    await setTask(dir, id, opts);

    return jsonResponse({ ok: true, id: before?.id ?? null, uuid: before?.uuid ?? null }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

/** True when `pathname`'s first segment is `api` (bare `/api` or `/api/...`). */
function isApiNamespace(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Serve a non-API route from the built SPA bundle (prod binary). Serving is
 * strictly MANIFEST-KEYED: we look up the exact request path in the embedded
 * asset map (never join the request onto a filesystem path — no traversal
 * surface). The rules:
 *
 *   - "/" or "/index.html" → the SPA shell, text/html.
 *   - an EXACT manifest match (e.g. "/assets/index-XXX.js", "/favicon.ico",
 *     "/robots.txt", any built file at any depth) → that file with its content
 *     type.
 *   - no manifest match, and the path looks like a static asset — under
 *     "/assets/" OR with a file extension (e.g. "/missing.js", "/favicon.ico")
 *     → a real 404. Never SPA-fall-back, or the browser would get HTML where it
 *     expected JS/CSS/an image and fail silently.
 *   - no manifest match, extensionless (e.g. "/board/123") → SPA fallback to
 *     index.html, so the client router owns deep links.
 *
 * This is a single-binary localhost board, so caching headers are intentionally
 * omitted.
 */
function serveAsset(assets: AssetBundle, pathname: string): Response {
  if (pathname === "/" || pathname === "/index.html") {
    return new Response(assets.indexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const blob = assets.assets.get(pathname);
  if (blob) {
    return new Response(blob, { headers: { "content-type": contentTypeFor(pathname) } });
  }
  // No exact match. An asset-looking path (under /assets/ or with a file
  // extension) is a real 404, not a client route — never SPA-fall-back.
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const looksLikeAsset = pathname.startsWith("/assets/") || lastSegment.includes(".");
  if (looksLikeAsset) {
    return errorResponse(new TasksError("NOT_FOUND", "no such asset", { path: pathname }));
  }
  // SPA fallback: unknown extensionless route renders the shell, client router takes over.
  return new Response(assets.indexHtml, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Map a thrown error to the project's error envelope + an HTTP status. This is
 * the in-server replacement for the CLI's `failFromError`/`emit` path: it must
 * not call `process.exit`. A `TasksError` carries its stable `code` through;
 * anything else becomes a generic 500 INTERNAL.
 */
function errorResponse(err: unknown): Response {
  if (err instanceof TasksError) {
    return jsonResponse(
      { error: { code: err.code, message: err.message, details: err.details ?? {} } },
      statusForCode(err.code),
    );
  }
  return jsonResponse(
    { error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err), details: {} } },
    500,
  );
}

/**
 * The server's error contract: map a `TasksError.code` to an HTTP status.
 * Reused by every later write endpoint (#14, #15, #16).
 */
export function statusForCode(code: string): number {
  switch (code) {
    case "NOT_FOUND":
    case "NOT_INITIALIZED":
    case "UNKNOWN_UUID":
      return 404;
    case "STORE_DIRTY":
    case "CONFLICT":
    case "DEP_EXISTS":
      return 409;
    case "INVALID_TITLE":
    case "INVALID_ATTENDANCE":
    case "INVALID_EFFORT":
    case "INVALID_COLUMN":
    case "INVALID_SINCE":
    case "SELF_LINK":
    case "CYCLE_DETECTED":
    case "MISSING_FIELD":
      return 400;
    case "FLOCK_MISSING":
      return 503;
    default:
      return 500;
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
