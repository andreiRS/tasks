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
   * When provided and the array for a task is non-empty, a trailing
   * `[blocked by #N,#M]` marker is appended after the O·M cluster.
   * Ids in each array are assumed already sorted ascending.
   */
  blockedBy?: Map<string, number[]>;
}

/**
 * Format the trailing `[blocked by #N,#M]` marker for a task, or an empty
 * string when the task has no unresolved blockers (or no lookup was provided).
 */
function blockedByMarker(task: TaskData, map: Map<string, number[]> | undefined): string {
  if (!map) return "";
  const ids = map.get(task.uuid);
  if (!ids || ids.length === 0) return "";
  return ` [blocked by ${ids.map((n) => `#${n}`).join(",")}]`;
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
 * Build a compact glyph cluster showing attendance and effort.
 * attendance: `○` = attended, `●` = unattended
 * effort:     `·L` = low, `·M` = medium, `·H` = high
 */
function glyphs(task: TaskData): string {
  const attendanceGlyph = task.attendance === "unattended" ? "●" : "○";
  const effortMap: Record<string, string> = { low: "·L", medium: "·M", high: "·H" };
  const effortGlyph = effortMap[task.effort] ?? "·M";
  return `${attendanceGlyph}${effortGlyph}`;
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

/**
 * Render a flat list of tasks as a human-readable string.
 *
 * Each task is one line: `#<id>  <column padded>  <title>  <glyphs>`
 * Rows are ordered by status (ready→doing→blocked→review→done→backlog), then by
 * short id ascending within each status. An empty task array renders as a single
 * `(no tasks)` line.
 *
 * When `options.color` is true, the column name is styled with cyan and the
 * id prefix is bold. Stripping ANSI from a colored render yields the plain render.
 */
export function renderList(tasks: TaskData[], options: RenderOptions): string {
  const color = options.color === true;

  if (tasks.length === 0) {
    return "(no tasks)\n";
  }

  const lines: string[] = [];
  for (const task of sortForList(tasks)) {
    const id = style(`#${task.id}`, ANSI.bold, color);
    const col = style(task.column.padEnd(8, " "), ANSI.cyan, color);
    const g = style(glyphs(task), ANSI.dim, color);
    const marker = blockedByMarker(task, options.blockedBy);
    lines.push(`${id}  ${col}  ${task.title}  ${g}${marker}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Render a board view as stacked sections: one section per column in canonical
 * order. Each section shows the column name as a header, then one task per line
 * as `  #<id> <title>`. Empty columns show `  (empty)`.
 *
 * Pinned layout:
 *   backlog
 *     #1 alpha
 *     #2 beta
 *   ready
 *     (empty)
 *   ...
 */
export function renderBoard(grouped: Record<string, TaskData[]>, options: RenderOptions): string {
  const color = options.color === true;
  const lines: string[] = [];

  for (const col of COLUMNS) {
    const tasks = grouped[col] ?? [];
    lines.push(style(col, ANSI.bold, color));
    if (tasks.length === 0) {
      lines.push(`  ${style("(empty)", ANSI.dim, color)}`);
    } else {
      for (const task of tasks) {
        const id = style(`#${task.id}`, ANSI.bold, color);
        const g = style(glyphs(task), ANSI.dim, color);
        const marker = blockedByMarker(task, options.blockedBy);
        lines.push(`  ${id} ${task.title}  ${g}${marker}`);
      }
    }
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
