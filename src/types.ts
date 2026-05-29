export interface TaskData {
  id: number;
  uuid: string;
  title: string;
  column: string;
  created_at: string;
  updated_at: string;
  body: string;
  deps: string[];
  attendance: "attended" | "unattended";
  effort: "low" | "medium" | "high";
}

/**
 * The editor-runner contract. The runner is given the absolute path to the
 * task file and should return the editor's exit code. Throwing is allowed and
 * surfaced as EDITOR_FAILED by the caller.
 */
export type EditorRunner = (filePath: string) => Promise<number>;
