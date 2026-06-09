import type { TaskData } from "../store.ts";
import { parseAcceptanceCriteria } from "../acceptance.ts";
import { nowMs } from "../clock.ts";

/**
 * Decorate a TaskData object with the `acceptance_criteria` field parsed from
 * its `body`. Always emitted as a string (empty string when absent).
 */
export function withAcceptanceCriteria<T extends { body: string }>(
  task: T
): T & { acceptance_criteria: string } {
  return { ...task, acceptance_criteria: parseAcceptanceCriteria(task.body) };
}

/**
 * Apply the done-column cutoff filter to a task list.
 */
export function applyDoneCutoff(
  tasks: TaskData[],
  allFlag: boolean,
  sinceDays: number
): TaskData[] {
  if (allFlag) return tasks;
  const cutoffMs = sinceDays * 24 * 60 * 60 * 1000;
  const now = nowMs();
  return tasks.filter((t) => {
    if (t.column !== "done") return true;
    const updatedMs = new Date(t.updated_at).getTime();
    return now - updatedMs <= cutoffMs;
  });
}
