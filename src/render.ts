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
 * Render a flat list of tasks as a human-readable string.
 *
 * Each task is one line: `#<id>  <column padded>  <title>  <glyphs>`
 * An empty task array renders as a single `(no tasks)` line.
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
  for (const task of tasks) {
    const id = style(`#${task.id}`, ANSI.bold, color);
    const col = style(task.column.padEnd(8, " "), ANSI.cyan, color);
    const g = style(glyphs(task), ANSI.dim, color);
    lines.push(`${id}  ${col}  ${task.title}  ${g}`);
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
        lines.push(`  ${id} ${task.title}  ${g}`);
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
 *   agent_ready:   <bool>
 *   human_in_loop: <bool>
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
    lines.push(`${label("deps:")}${task.deps[0]}`);
    for (let i = 1; i < task.deps.length; i++) {
      lines.push(`${label("")}${task.deps[i]}`);
    }
  }

  lines.push(`${label("agent_ready:")}${task.agent_ready}`);
  lines.push(`${label("human_in_loop:")}${task.human_in_loop}`);
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
