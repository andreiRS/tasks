import type { TaskData } from "./store.ts";

/**
 * Render a normalized task as a plain-text, human-readable string.
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
 * Color-agnostic: returns plain text. A future cycle will introduce
 * `colorize(text, style)` and wrap selected substrings; the layout
 * itself will not change.
 */
export function renderTask(task: TaskData): string {
  const label = (s: string) => s.padEnd(15, " ");
  const lines: string[] = [];

  lines.push(`#${task.id} ${task.title}`);
  lines.push("");

  lines.push(`${label("uuid:")}${task.uuid}`);
  lines.push(`${label("column:")}${task.column}`);

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
