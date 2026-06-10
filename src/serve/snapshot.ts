import { existsSync } from "node:fs";
import { COLUMNS, type TaskData } from "../store.ts";
import { gitCaptureSync } from "./git-head.ts";

/** A single card in a board lane. */
export interface BoardTask {
  id: number;
  uuid: string;
  title: string;
  body: string;
  column: string;
  effort: "low" | "medium" | "high";
  attendance: "attended" | "unattended";
  updated_at: string;
  created_at: string;
  /** Short ids of unresolved direct blockers, ascending (archive-aware). */
  blockedBy: number[];
}

/** Store HEAD info so the board can show "updated X ago". */
export interface BoardHead {
  sha: string;
  /** Commit timestamp, ISO-8601. */
  committed_at: string;
}

/** The /api/board response: six lanes + store head. */
export interface BoardSnapshot {
  columns: string[];
  lanes: Record<string, BoardTask[]>;
  head: BoardHead | null;
}

/**
 * Build the board snapshot from the live tasks and the pre-computed,
 * archive-aware blocked-by map. Groups only the six live Columns (Archive is
 * excluded — it is not a Column), sorting each lane oldest-first by
 * `created_at` ascending so the top of `ready` equals `tasks next`.
 */
export function buildBoardSnapshot(
  dir: string,
  liveTasks: TaskData[],
  blockedBy: Map<string, number[]>,
): BoardSnapshot {
  const lanes: Record<string, BoardTask[]> = {};
  for (const col of COLUMNS) lanes[col] = [];

  for (const t of liveTasks) {
    if (!lanes[t.column]) continue; // archive or unknown column: skip
    lanes[t.column].push({
      id: t.id,
      uuid: t.uuid,
      title: t.title,
      body: t.body,
      column: t.column,
      effort: t.effort,
      attendance: t.attendance,
      updated_at: t.updated_at,
      created_at: t.created_at,
      blockedBy: blockedBy.get(t.uuid) ?? [],
    });
  }

  for (const col of COLUMNS) {
    lanes[col].sort((a, b) => {
      const ta = Date.parse(a.created_at);
      const tb = Date.parse(b.created_at);
      if (ta !== tb) return ta - tb; // oldest-first
      return a.id - b.id; // stable tiebreak on id
    });
  }

  return { columns: [...COLUMNS], lanes, head: readHead(dir) };
}

/** Read the Store's HEAD sha + commit time, or null if unavailable. */
function readHead(dir: string): BoardHead | null {
  if (!existsSync(dir)) return null;
  const out = gitCaptureSync(dir, ["log", "-1", "--format=%H%n%cI"]);
  if (out === null) return null;
  const [sha, committed_at] = out.split("\n");
  if (!sha) return null;
  return { sha, committed_at: committed_at ?? "" };
}
