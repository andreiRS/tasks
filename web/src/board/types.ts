// Shape of the `/api/board` contract (server-owned — see issue #18 handoff).
// Lanes arrive sorted oldest-first; `columns` gives canonical lane order.

export type Effort = "low" | "medium" | "high";
export type Attendance = "attended" | "unattended";

export interface BoardTask {
  id: number;
  uuid: string;
  title: string;
  body: string;
  column: string;
  effort: Effort;
  attendance: Attendance;
  updated_at: string;
  created_at: string;
  /** Short ids of unresolved blockers; empty = not blocked. */
  blockedBy: number[];
}

export interface BoardHead {
  sha: string;
  committed_at: string;
}

export interface Board {
  columns: string[];
  lanes: Record<string, BoardTask[]>;
  head: BoardHead | null;
}
