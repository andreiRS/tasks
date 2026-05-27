import type { TaskData } from "./store.ts";

/**
 * Options for {@link renderTask}.
 *
 * When `color` is true, the renderer wraps select substrings in ANSI escape
 * sequences. When false (the default), the output is plain text with no ANSI.
 */
export interface RenderOptions {
  color?: boolean;
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
  lines.push(`${label("created_at:")}${task.created_at}`);
  lines.push(`${label("updated_at:")}${task.updated_at}`);

  lines.push("");

  if (task.body.length > 0) {
    lines.push(task.body);
  }

  // Always end with a single trailing newline.
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}
