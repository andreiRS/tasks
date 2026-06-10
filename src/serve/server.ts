import {
  COLUMNS,
  EFFORT_VALUES,
  createTask,
  findAllTasks,
  findArchivedTasks,
  findTask,
  moveTask,
  TasksError,
  validateTitle,
} from "../store.ts";
import { computeBlockedBy } from "../render.ts";
import { buildBoardSnapshot } from "./snapshot.ts";

export interface ServeOptions {
  dir: string;
  port: number;
}

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
export function startBoardServer(opts: ServeOptions): ReturnType<typeof Bun.serve> {
  const { dir } = opts;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/board") {
        return handleBoard(dir);
      }
      if (req.method === "POST" && url.pathname === "/api/tasks") {
        return handleCreate(dir, req);
      }
      const moveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/move$/);
      if (req.method === "POST" && moveMatch) {
        return handleMove(dir, decodeURIComponent(moveMatch[1]!), req);
      }
      // Route the 404 through the single envelope path (errorResponse) so there
      // is exactly one place that builds the error shape + picks the status.
      return errorResponse(new TasksError("NOT_FOUND", "no such route", { path: url.pathname }));
    },
  });

  process.stdout.write(`tasks board listening on http://127.0.0.1:${server.port}\n`);
  return server;
}

/** GET /api/board — the six-lane board snapshot. */
function handleBoard(dir: string): Response {
  try {
    const liveTasks = findAllTasks(dir);
    const archivedTasks = findArchivedTasks(dir);
    // Archived deps count as Complete, so feed live + archived into the
    // blocker computation; archive itself is excluded from the lanes by
    // buildBoardSnapshot (it only groups live tasks).
    const blockedBy = computeBlockedBy([...liveTasks, ...archivedTasks]);
    const snapshot = buildBoardSnapshot(dir, liveTasks, blockedBy);
    return jsonResponse(snapshot, 200);
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
