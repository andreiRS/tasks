import { existsSync } from "node:fs";
import { findAllTasks, findArchivedTasks, groupTasksByColumn, resolveStoreDir, type TaskData } from "../store.ts";
import { renderBoard, computeBlockedBy, BOARD_DEFAULT_WIDTH } from "../render.ts";
import { emit, outputContext } from "../cli/output.ts";
import { applyDoneCutoff, withAcceptanceCriteria } from "../cli/filters.ts";
import { parseSinceDays } from "../cli/validation.ts";
import { getFlagValue } from "../cli/args.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);
  const allFlag = rest.includes("--all");

  let sinceDays = 7;
  const sinceVal = getFlagValue(rest, "--since");
  if (sinceVal !== undefined) {
    const parsed = parseSinceDays(sinceVal);
    if (parsed === null) {
      const msg = `invalid --since value: ${sinceVal}. Expected format: <N>d (e.g. 7d, 30d)`;
      emit({ ok: false, code: "INVALID_SINCE", message: msg, details: { value: sinceVal } }, ctx);
    }
    sinceDays = parsed;
  }

  const dir = resolveStoreDir(process.cwd());

  if (!existsSync(dir)) {
    const msg = "store not initialized; run `tasks new` to create it";
    emit({ ok: false, code: "NOT_INITIALIZED", message: msg }, ctx);
  }

  const liveTasks = findAllTasks(dir);
  const archivedTasks = findArchivedTasks(dir);
  // Archived tasks feed blocker resolution but never the rendered grouping
  // (archive is not a Column). See ADR-0010.
  const blockedBy = computeBlockedBy([...liveTasks, ...archivedTasks]);
  const tasks = applyDoneCutoff(liveTasks, allFlag, sinceDays);

  const grouped = groupTasksByColumn(tasks);

  const groupedWithAc: Record<
    string,
    Array<TaskData & { acceptance_criteria: string; blockedBy: number[] }>
  > = {};
  for (const [col, list] of Object.entries(grouped)) {
    groupedWithAc[col] = list.map((t) => ({
      ...withAcceptanceCriteria(t),
      blockedBy: blockedBy.get(t.uuid) ?? [],
    }));
  }
  emit(
    {
      ok: true,
      json: groupedWithAc,
      text: (c) => renderBoard(grouped, { color: c.color, blockedBy, width: resolveBoardWidth() }),
    },
    ctx,
  );
}

/**
 * Resolve the board's horizontal width budget:
 *   1. `process.stdout.columns` when stdout is a TTY.
 *   2. else `Number(process.env.COLUMNS)` when it parses to a positive finite number.
 *   3. else `BOARD_DEFAULT_WIDTH` (120).
 * Kept in the command so `renderBoard` stays a pure function of its inputs.
 */
function resolveBoardWidth(): number {
  if (process.stdout.isTTY && typeof process.stdout.columns === "number") {
    return process.stdout.columns;
  }
  const env = Number(process.env.COLUMNS);
  if (Number.isFinite(env) && env > 0) return env;
  return BOARD_DEFAULT_WIDTH;
}
