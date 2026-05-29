import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { COLUMNS, ARCHIVE_DIR, DEFAULT_ATTENDANCE, DEFAULT_EFFORT } from "./constants.ts";
import type { TaskData } from "./types.ts";
import { resolveAttendance, resolveEffort } from "./validation.ts";
import { parseTaskFile } from "./task-file.ts";

/**
 * Build a `TaskData` record from parsed frontmatter, the resolved column, and
 * the raw body. Centralizes the identical field mapping (and enum-default
 * normalization) that `findAllTasks`, `findArchivedTasks`, and `findTask` each
 * performed inline.
 */
function frontmatterToTaskData(
  fm: Record<string, unknown>,
  column: string,
  body: string,
): TaskData {
  return {
    id: fm.id as number,
    uuid: fm.uuid as string,
    title: fm.title as string,
    column,
    created_at: fm.created_at as string,
    updated_at: fm.updated_at as string,
    body,
    deps: Array.isArray(fm.deps) ? (fm.deps as string[]) : [],
    attendance: resolveAttendance(fm.attendance) ?? DEFAULT_ATTENDANCE,
    effort: resolveEffort(fm.effort) ?? DEFAULT_EFFORT,
  };
}

/**
 * Return all tasks in the store, grouped by column in canonical order
 * (backlog, ready, doing, blocked, review, done), and within each column
 * sorted by filename (which starts with the numeric id, giving stable ordering).
 *
 * Returns an empty array if the store does not exist.
 * Does NOT auto-initialize the store.
 */
export function findAllTasks(dir: string): TaskData[] {
  if (!existsSync(dir)) {
    return [];
  }

  const results: TaskData[] = [];

  for (const col of COLUMNS) {
    const colDir = join(dir, col);
    if (!existsSync(colDir)) continue;

    let files: string[];
    try {
      files = readdirSync(colDir)
        .filter((f) => f.endsWith(".md"))
        .sort(); // lexicographic = id-ascending for numeric-prefixed filenames
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

      const { fm, body } = parseTaskFile(raw);
      if (typeof fm.id !== "number") continue; // skip unparseable files

      results.push(frontmatterToTaskData(fm, col, body));
    }
  }

  return results;
}

/**
 * Return all tasks currently in the `archive/` sibling directory.
 *
 * Same parsing rules as `findAllTasks`, but the resulting TaskData carries
 * `column: "archive"` so callers can filter or treat them specially.
 * Returns an empty array if the store or archive/ directory does not exist.
 * Does NOT auto-initialize the store.
 */
export function findArchivedTasks(dir: string): TaskData[] {
  const archiveDir = join(dir, ARCHIVE_DIR);
  if (!existsSync(archiveDir)) return [];

  const results: TaskData[] = [];
  let files: string[];
  try {
    files = readdirSync(archiveDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }

  for (const filename of files) {
    let raw: string;
    try {
      raw = readFileSync(join(archiveDir, filename), "utf-8");
    } catch {
      continue;
    }
    const { fm, body } = parseTaskFile(raw);
    if (typeof fm.id !== "number") continue;
    results.push(frontmatterToTaskData(fm, ARCHIVE_DIR, body));
  }
  return results;
}

/**
 * Group an array of tasks by column into a Record with all six column keys.
 * Each key is always present (empty array if no tasks in that column).
 */
export function groupTasksByColumn(tasks: TaskData[]): Record<string, TaskData[]> {
  const grouped: Record<string, TaskData[]> = {};
  for (const col of COLUMNS) {
    grouped[col] = [];
  }
  for (const task of tasks) {
    if (grouped[task.column]) {
      grouped[task.column].push(task);
    }
  }
  return grouped;
}

// ─── Deep Task-record write primitive ────────────────────────────────────────
//
// Two layers retire the regex frontmatter surgery + ad-hoc git dance that every
// mutation used to re-derive (CONTEXT.md's claim that frontmatter is written via
// the `yaml` Document API is made true here):
//   - TaskFile  — a loaded task: on-disk location, parsed frontmatter Document,
//                 raw body. Typed get/set over frontmatter, canonical slug
//                 filename. No git.
//   - stageTaskFile / commitTaskChange — write + bump updated_at + stage, doing
//                 a `git mv` when the slug or column changed; commit exactly once.

/**
 * Find a task by short id (positive integer string) or UUID.
 * Walks all six column directories.
 * Returns TaskData (with normalized defaults) or null if not found.
 *
 * Does NOT auto-initialize the store.
 */
export function findTask(dir: string, idOrUuid: string): TaskData | null {
  if (!existsSync(dir)) {
    return null;
  }

  const byShortId = /^\d+$/.test(idOrUuid);
  const targetId = byShortId ? parseInt(idOrUuid, 10) : null;

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

      const { fm, body } = parseTaskFile(raw);

      const matches = byShortId
        ? fm.id === targetId
        : fm.uuid === idOrUuid;

      if (matches) {
        return frontmatterToTaskData(fm, col, body);
      }
    }
  }

  return null;
}
