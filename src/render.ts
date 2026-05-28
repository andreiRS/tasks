import type { TaskData } from "./store.ts";
import { COLUMNS } from "./store.ts";

/**
 * Options for {@link renderTask}.
 *
 * When `color` is true, the renderer wraps select substrings in ANSI escape
 * sequences. When false (the default), the output is plain text with no ANSI.
 */
export interface RenderOptions {
  color?: boolean;
  /** Resolved forward dependency edges (what this task depends on). */
  deps_out?: Array<{ uuid: string; id: number; title: string }>;
  /** Resolved reverse dependency edges (what depends on this task). */
  deps_in?: Array<{ uuid: string; id: number; title: string }>;
  /**
   * Per-task unresolved direct blocker short ids, keyed by task uuid.
   * When provided and the array for a task is non-empty, the board renders a
   * right-pinned `← #N` dependency arrow on that task's row.
   * Ids in each array are assumed already sorted ascending.
   */
  blockedBy?: Map<string, number[]>;
  /**
   * Resolved horizontal width budget for the board layout. The COMMAND resolves
   * this (TTY columns → COLUMNS env → 120) and passes it in; the renderer never
   * reads `process` directly, keeping it a pure function of (grouped, options).
   */
  width?: number;
}

/**
 * Compute, per task, the sorted short ids of direct blockers that are not
 * yet in `done`. Tasks with no unresolved blockers map to an empty array.
 *
 * Shared by `list` and `board` so the marker and `blockedBy` JSON field
 * derive from one source of truth.
 */
export function computeBlockedBy(tasks: TaskData[]): Map<string, number[]> {
  const byUuid = new Map<string, TaskData>();
  for (const t of tasks) byUuid.set(t.uuid, t);
  const out = new Map<string, number[]>();
  for (const t of tasks) {
    const ids: number[] = [];
    for (const depUuid of t.deps) {
      const dep = byUuid.get(depUuid);
      if (!dep) continue; // dangling dep is not surfaced here
      // Archived tasks count as Complete (ADR-0010), same as done.
      if (dep.column === "done" || dep.column === "archive") continue;
      ids.push(dep.id);
    }
    ids.sort((a, b) => a - b);
    out.set(t.uuid, ids);
  }
  return out;
}

// Minimal ANSI palette. Hand-rolled, no third-party color library.
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
} as const;

/**
 * Wrap `s` in the given ANSI style codes when `color` is true, otherwise
 * return `s` unchanged. The styling layer is purely decorative: stripping
 * ANSI escapes from a colored render must yield byte-for-byte the same
 * string as the plain render.
 */
function style(s: string, code: string, color: boolean): string {
  return color ? `${code}${s}${ANSI.reset}` : s;
}

/**
 * Status order for the human list view, top to bottom. Front-loads the working
 * set (ready→doing→blocked→review) and sinks completed work and the raw backlog.
 * This governs only the text render; `--json` keeps the canonical column order.
 */
const LIST_STATUS_ORDER = ["ready", "doing", "blocked", "review", "done", "backlog"];

/**
 * Return a copy of `tasks` ordered for the human list view: by status using
 * {@link LIST_STATUS_ORDER}, then by short id ascending within each status.
 * Columns not in the status order sort last, stably.
 */
function sortForList(tasks: TaskData[]): TaskData[] {
  const rank = (col: string) => {
    const i = LIST_STATUS_ORDER.indexOf(col);
    return i === -1 ? LIST_STATUS_ORDER.length : i;
  };
  return [...tasks].sort((a, b) => {
    const ra = rank(a.column);
    const rb = rank(b.column);
    if (ra !== rb) return ra - rb;
    return a.id - b.id;
  });
}

// Fixed layout budget for the human list view (see docs/specs/list-rendering.md).
// Layout is pinned to a ~120-col target and is NOT adaptive to the terminal.
const LIST_TOTAL_W = 120;
const LIST_GAP = 2;
const LIST_COL_W = 7; // longest column name: "backlog"
const LIST_GUTTER_W = 6; // width of the "[auto]" gutter
const LIST_ARROW_RESERVE = 12; // tail reserved for the dependency arrow

/**
 * Build the dependency-arrow tail for a row, fitting it into
 * {@link LIST_ARROW_RESERVE} columns. Returns "" when there are no unmet
 * blockers. When the full `← #a, #b, …` list overflows the tail, as many ids
 * as fit are shown followed by ` +N` (N = hidden count); room for ` +N` is
 * reserved so the tail never overflows, and at least one id is always shown.
 */
function dependencyArrow(ids: number[]): string {
  if (ids.length === 0) return "";
  const full = `← ${ids.map((n) => `#${n}`).join(", ")}`;
  if (full.length <= LIST_ARROW_RESERVE) return full;
  for (let k = ids.length - 1; k >= 1; k--) {
    const candidate = `← ${ids.slice(0, k).map((n) => `#${n}`).join(", ")} +${ids.length - k}`;
    if (candidate.length <= LIST_ARROW_RESERVE) return candidate;
  }
  // Always show at least one id, even if it nominally overflows.
  return `← #${ids[0]} +${ids.length - 1}`;
}

/**
 * Truncate `title` to at most `width` display columns, replacing the overflow
 * with a trailing `…` (which counts as one column). Does not pad short titles.
 */
function fitTitle(title: string, width: number): string {
  if (title.length <= width) return title;
  return title.slice(0, width - 1) + "…";
}

/**
 * Render a flat list of tasks as a human-readable string.
 *
 * Each row lays out, left to right with a 2-space gap between fields:
 *   `#<id>`  ·  column  ·  [auto] gutter (only if any row is unattended)  ·
 *   title (padded/truncated to a fixed field)  ·  `← #N, #N` arrow (only on
 *   rows with unmet upstream blockers, pinned to a fixed tab stop).
 *
 * Rows are ordered by status (ready→doing→blocked→review→done→backlog), then by
 * short id ascending within each status. An empty task array renders as a single
 * `(no tasks)` line.
 *
 * When `options.color` is true, the id prefix is bold and the column name cyan.
 * The gutter and arrow are not tinted. Stripping ANSI from a colored render
 * yields byte-for-byte the plain render.
 */
export function renderList(tasks: TaskData[], options: RenderOptions): string {
  const color = options.color === true;

  if (tasks.length === 0) {
    return "(no tasks)\n";
  }

  const ordered = sortForList(tasks);
  const blockedBy = options.blockedBy;

  const idW = Math.max(...ordered.map((t) => `#${t.id}`.length));
  const anyUnattended = ordered.some((t) => t.attendance === "unattended");

  const prefix =
    idW + LIST_GAP + LIST_COL_W + LIST_GAP + (anyUnattended ? LIST_GUTTER_W + LIST_GAP : 0);
  const titleW = Math.max(10, LIST_TOTAL_W - prefix - LIST_GAP - LIST_ARROW_RESERVE);

  const lines: string[] = [];
  for (const task of ordered) {
    const idPlain = `#${task.id}`.padEnd(idW, " ");
    const id = style(idPlain, ANSI.bold, color);
    const colPlain = task.column.padEnd(LIST_COL_W, " ");
    const col = style(colPlain, ANSI.cyan, color);

    const gutter = anyUnattended
      ? (task.attendance === "unattended" ? "[auto]" : " ".repeat(LIST_GUTTER_W)) + " ".repeat(LIST_GAP)
      : "";

    const ids = blockedBy?.get(task.uuid) ?? [];
    const arrow = dependencyArrow(ids);

    const titleText = fitTitle(task.title, titleW);
    // Pad the title to the fixed field only when an arrow follows, so arrows
    // pin to the tab stop; rows without arrows carry no trailing whitespace.
    const body =
      arrow.length > 0
        ? `${titleText.padEnd(titleW, " ")}${" ".repeat(LIST_GAP)}${arrow}`
        : titleText;

    lines.push(`${id}${" ".repeat(LIST_GAP)}${col}${" ".repeat(LIST_GAP)}${gutter}${body}`);
  }

  return lines.join("\n") + "\n";
}

// ─── Board layout (see docs/specs/board-rendering.md) ────────────────────────

// Lifecycle order of lanes, left to right.
const BOARD_LANE_ORDER = ["backlog", "ready", "doing", "blocked", "review", "done"];
// Lane separator: space, single-pipe vertical rule, space (3 cols).
const BOARD_SEP = " │ ";
// Fixed lane content widths.
const BOARD_BACKLOG_W = 36; // populated backlog
const BOARD_OTHER_W = 24; // any other populated lane
const BOARD_EMPTY_W = 11; // any lane with 0 tasks (slim); holds "BACKLOG (0)"
// Reuse the list view's 2-space field gap and 6-col "[auto]" gutter.
const BOARD_GAP = LIST_GAP;
const BOARD_GUTTER_W = LIST_GUTTER_W;
// Minimum title field width when reserves squeeze the lane.
const BOARD_TITLE_MIN = 4;
// Default width budget when neither a TTY nor COLUMNS is available.
export const BOARD_DEFAULT_WIDTH = 120;

/** Fixed content width for a lane given its column name and task count. */
function laneWidth(col: string, count: number): number {
  if (count === 0) return BOARD_EMPTY_W;
  return col === "backlog" ? BOARD_BACKLOG_W : BOARD_OTHER_W;
}

/** Pad (or hard-truncate) a plain string to exactly `w` display columns. */
function padCell(s: string, w: number): string {
  if (s.length > w) return s.slice(0, w);
  return s.padEnd(w, " ");
}

/**
 * Render a single lane (header, rule, body rows) as an array of fixed-width
 * plain-text cells, each exactly `w` columns wide. The header text is the only
 * styled fragment; styling never changes the cell's display width, so columns
 * stay aligned under both `--color` and plain output.
 */
function renderLane(
  col: string,
  tasks: TaskData[],
  blockedBy: Map<string, number[]> | undefined,
  color: boolean,
): string[] {
  const w = laneWidth(col, tasks.length);
  const headerText = `${col.toUpperCase()} (${tasks.length})`;

  // Header cell: pad the PLAIN text to width, then style only the text span so
  // the trailing pad is never wrapped in escape codes.
  const headerCell =
    style(headerText, ANSI.bold, color) + " ".repeat(Math.max(0, w - headerText.length));
  const ruleCell = "─".repeat(w);

  const cells: string[] = [headerCell, ruleCell];

  if (tasks.length === 0) {
    cells.push(padCell("no tasks", w));
    return cells;
  }

  const ordered = [...tasks].sort((a, b) => a.id - b.id);

  const idW = Math.max(...ordered.map((t) => `#${t.id}`.length));
  const anyUnattended = ordered.some((t) => t.attendance === "unattended");
  const depsFor = (t: TaskData) => blockedBy?.get(t.uuid) ?? [];
  const anyDeps = ordered.some((t) => depsFor(t).length > 0);

  // Per-lane reserves. The arrow tail covers `← #<id>` plus a ` +k` overflow.
  const arrowReserve = anyDeps ? 2 + idW + 3 : 0;
  const gutterCost = anyUnattended ? BOARD_GUTTER_W + BOARD_GAP : 0;
  const arrowCost = anyDeps ? BOARD_GAP + arrowReserve : 0;
  const titleW = Math.max(BOARD_TITLE_MIN, w - idW - BOARD_GAP - gutterCost - arrowCost);

  for (const task of ordered) {
    const idPlain = `#${task.id}`.padEnd(idW, " ");
    const id = style(idPlain, ANSI.bold, color);

    const gutter = anyUnattended
      ? (task.attendance === "unattended" ? "[auto]" : " ".repeat(BOARD_GUTTER_W)) +
        " ".repeat(BOARD_GAP)
      : "";

    const titleText = fitTitle(task.title, titleW).padEnd(titleW, " ");

    let tail = "";
    if (anyDeps) {
      const arrow = boardArrow(depsFor(task));
      tail = " ".repeat(BOARD_GAP) + arrow.padEnd(arrowReserve, " ");
    }

    const rowPlain = `${idPlain}${" ".repeat(BOARD_GAP)}${gutter}${titleText}${tail}`;
    // Trim trailing whitespace, then pad/clamp to exactly the lane width so the
    // cell owns its slack and never overflows into the next lane.
    const padded = padCell(rowPlain.replace(/\s+$/, ""), w);
    // Re-apply the bold id span over the padded plain row (id is at index 0).
    cells.push(color ? padded.replace(idPlain, id) : padded);
  }

  return cells;
}

/**
 * Format the dependency arrow tail for a board row within `reserve` columns.
 * A single dep renders `← #N`; multiple deps render `← #first +k` (k = hidden
 * count). Returns "" when there are no unmet upstream deps.
 */
function boardArrow(ids: number[]): string {
  if (ids.length === 0) return "";
  if (ids.length === 1) return `← #${ids[0]}`;
  return `← #${ids[0]} +${ids.length - 1}`;
}

/**
 * Render the board as side-by-side lanes in lifecycle order, separated by
 * ` │ `. Each lane has a header (`NAME (N)` in uniform caps), a `─` rule line
 * spanning the lane width, then either task rows or the literal `no tasks`.
 *
 * Lane content widths are fixed: populated `backlog` = 36, any other populated
 * lane = 24, any empty lane = 11 (slim). Task rows carry a per-lane `[auto]`
 * gutter (only when the lane has an unattended task) and a right-pinned
 * `← #N` dependency arrow (reserved only when the lane has unmet deps).
 *
 * `options.width` is the resolved width budget. This slice renders all six
 * lanes side-by-side; adaptive dropping and the vertical fallback are not yet
 * implemented.
 */
export function renderBoard(grouped: Record<string, TaskData[]>, options: RenderOptions): string {
  const color = options.color === true;
  const blockedBy = options.blockedBy;

  const laneCells = BOARD_LANE_ORDER.map((col) =>
    renderLane(col, grouped[col] ?? [], blockedBy, color),
  );

  const rows = Math.max(...laneCells.map((c) => c.length));
  const widths = BOARD_LANE_ORDER.map((col) =>
    laneWidth(col, (grouped[col] ?? []).length),
  );

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const parts = laneCells.map((cells, i) =>
      r < cells.length ? cells[r] : " ".repeat(widths[i]),
    );
    // Right-trim the assembled line so empty tails carry no trailing spaces.
    lines.push(parts.join(BOARD_SEP).replace(/\s+$/, ""));
  }

  return lines.join("\n") + "\n";
}

/**
 * Render a normalized task as a human-readable string.
 *
 * Layout (pinned by tests):
 *   #<id> <title>
 *   <blank line>
 *   uuid:          <uuid>
 *   column:        <column>
 *   deps:          (none) | <first uuid>
 *                  <next uuid>
 *                  ...
 *   created_at:    <iso>
 *   updated_at:    <iso>
 *   <blank line>
 *   <body, or nothing if empty>
 *
 * When `options.color` is true, the title line is bold and the metadata
 * field labels are dim. The layout is identical in both modes.
 */
export function renderTask(task: TaskData, options: RenderOptions = {}): string {
  const color = options.color === true;
  const label = (s: string) => style(s.padEnd(15, " "), ANSI.dim, color);
  const lines: string[] = [];

  const titleLine = `#${task.id} ${task.title}`;
  lines.push(style(titleLine, ANSI.bold, color));
  lines.push("");

  lines.push(`${label("uuid:")}${task.uuid}`);
  lines.push(`${label("column:")}${style(task.column, ANSI.cyan, color)}`);

  if (task.deps.length === 0) {
    lines.push(`${label("deps:")}(none)`);
  } else {
    const depsOutMap = new Map((options.deps_out ?? []).map((d) => [d.uuid, d]));
    const depLines = task.deps.map((u) => {
      const resolved = depsOutMap.get(u);
      return resolved ? `#${resolved.id} ${resolved.title}` : `<unknown> ${u}`;
    });
    lines.push(`${label("deps:")}${depLines[0]}`);
    for (let i = 1; i < depLines.length; i++) {
      lines.push(`${label("")}${depLines[i]}`);
    }
  }

  lines.push(`${label("Attendance:")}${task.attendance}`);
  lines.push(`${label("Effort:")}${task.effort}`);
  lines.push(`${label("created_at:")}${task.created_at}`);
  lines.push(`${label("updated_at:")}${task.updated_at}`);

  lines.push("");

  if (task.body.length > 0) {
    lines.push(task.body);
  }

  // Dependency sections (only when non-empty). Header is bold (like board
  // column headers); each entry is indented two spaces as `  #<id> <title>`.
  const depsOut = options.deps_out ?? [];
  const depsIn = options.deps_in ?? [];
  if (depsOut.length > 0) {
    lines.push(style("Depends on:", ANSI.bold, color));
    for (const d of depsOut) {
      const id = style(`#${d.id}`, ANSI.bold, color);
      lines.push(`  ${id} ${d.title}`);
    }
  }
  if (depsIn.length > 0) {
    lines.push(style("Blocks:", ANSI.bold, color));
    for (const d of depsIn) {
      const id = style(`#${d.id}`, ANSI.bold, color);
      lines.push(`  ${id} ${d.title}`);
    }
  }

  // Always end with a single trailing newline.
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}
