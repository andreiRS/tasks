import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { TasksError } from "./errors.ts";
import {
  COLUMNS,
  ATTENDANCE_VALUES,
  EFFORT_VALUES,
  DEFAULT_ATTENDANCE,
  DEFAULT_EFFORT,
} from "./constants.ts";
import type { TaskData } from "./types.ts";

/**
 * Resolve a raw frontmatter `attendance` value to a valid enum member or null
 * if the value is present-but-invalid. A missing value resolves to the default.
 */
export function resolveAttendance(value: unknown): "attended" | "unattended" | null {
  if (value === undefined || value === null) return DEFAULT_ATTENDANCE;
  if (typeof value !== "string") return null;
  if ((ATTENDANCE_VALUES as readonly string[]).includes(value)) {
    return value as "attended" | "unattended";
  }
  return null;
}

export function resolveEffort(value: unknown): "low" | "medium" | "high" | null {
  if (value === undefined || value === null) return DEFAULT_EFFORT;
  if (typeof value !== "string") return null;
  if ((EFFORT_VALUES as readonly string[]).includes(value)) {
    return value as "low" | "medium" | "high";
  }
  return null;
}

/**
 * Validate the attendance/effort enum values across every task file in the
 * store. Throws TasksError with code INVALID_ATTENDANCE or INVALID_EFFORT on
 * the first offending file. Missing fields are accepted (treated as defaults).
 *
 * Call from any mutating command (after the dirty-tree guard, before the
 * mutation proper) so an out-of-band corruption is surfaced before any new
 * commit lands.
 */
export function validateEnums(dir: string): void {
  if (!existsSync(dir)) return;
  for (const col of COLUMNS) {
    const colDir = join(dir, col);
    if (!existsSync(colDir)) continue;
    let files: string[];
    try {
      files = readdirSync(colDir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const filename of files) {
      const filePath = join(colDir, filename);
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const parts = raw.split(/^---\s*$/m);
      if (parts.length < 3) continue;
      let fm: Record<string, unknown>;
      try {
        fm = yamlParse(parts[1]) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (fm.attendance !== undefined && resolveAttendance(fm.attendance) === null) {
        throw new TasksError(
          "INVALID_ATTENDANCE",
          `task ${fm.uuid ?? filename} has invalid attendance: ${String(fm.attendance)}. Allowed: ${ATTENDANCE_VALUES.join(", ")}`,
          { uuid: fm.uuid, value: fm.attendance, allowed: [...ATTENDANCE_VALUES] },
        );
      }
      if (fm.effort !== undefined && resolveEffort(fm.effort) === null) {
        throw new TasksError(
          "INVALID_EFFORT",
          `task ${fm.uuid ?? filename} has invalid effort: ${String(fm.effort)}. Allowed: ${EFFORT_VALUES.join(", ")}`,
          { uuid: fm.uuid, value: fm.effort, allowed: [...EFFORT_VALUES] },
        );
      }
    }
  }
}

/**
 * Validate the dependency graph across all tasks in the store.
 *
 * Rules:
 *   - Every uuid referenced in a task's `deps` must correspond to an existing
 *     task in the store. Otherwise: throws TasksError(code=UNKNOWN_UUID).
 *   - The directed graph (edge: task -> dep) must be acyclic. A self-loop
 *     counts as a cycle. Otherwise: throws TasksError(code=CYCLE_DETECTED).
 *
 * Detection: iterative DFS with white/gray/black colors. The first offending
 * uuid (unknown or back-edge target) is surfaced in `details.uuid` for clearer
 * error envelopes.
 */
export function validateGraph(tasks: TaskData[]): void {
  const known = new Set(tasks.map((t) => t.uuid));

  // Unknown UUID check across all edges.
  for (const t of tasks) {
    for (const dep of t.deps) {
      if (!known.has(dep)) {
        throw new TasksError(
          "UNKNOWN_UUID",
          `task ${t.uuid} references unknown uuid: ${dep}`,
          { uuid: dep, referencedBy: t.uuid },
        );
      }
    }
  }

  // Cycle detection (DFS, white/gray/black).
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.uuid, WHITE);
  const adj = new Map<string, string[]>();
  for (const t of tasks) adj.set(t.uuid, t.deps);

  function dfs(start: string): string | null {
    const stack: { node: string; idx: number }[] = [{ node: start, idx: 0 }];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.idx >= neighbors.length) {
        color.set(frame.node, BLACK);
        stack.pop();
        continue;
      }
      const next = neighbors[frame.idx++];
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        return next; // back-edge → cycle
      }
      if (c === WHITE) {
        color.set(next, GRAY);
        stack.push({ node: next, idx: 0 });
      }
    }
    return null;
  }

  for (const t of tasks) {
    if ((color.get(t.uuid) ?? WHITE) === WHITE) {
      const cycleNode = dfs(t.uuid);
      if (cycleNode !== null) {
        throw new TasksError(
          "CYCLE_DETECTED",
          `dependency cycle detected involving uuid: ${cycleNode}`,
          { uuid: cycleNode },
        );
      }
    }
  }
}

/**
 * The validateTitle rules shared between `new` and `edit`.
 * Returns null if valid, or an error message otherwise.
 */
export function validateTitle(title: unknown): string | null {
  if (typeof title !== "string") return "title is required";
  if (title.trim() === "") return "title is required";
  if (/[\n\r]/.test(title)) return "title must be a single line (no newline characters)";
  if (title.length > 200) return `title must be 200 characters or fewer (got ${title.length})`;
  return null;
}
