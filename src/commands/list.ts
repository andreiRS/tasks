import { existsSync } from "node:fs";
import { COLUMNS, findAllTasks, findArchivedTasks, resolveStoreDir } from "../store.ts";
import { renderList, computeBlockedBy } from "../render.ts";
import { emit, outputContext } from "../cli/output.ts";
import { applyDoneCutoff, withAcceptanceCriteria } from "../cli/filters.ts";
import { parseSinceDays, validateEnumOrExit } from "../cli/validation.ts";
import { collectRepeated, getFlagValue } from "../cli/args.ts";

const VALID_ATTENDANCE = ["attended", "unattended"] as const;
const VALID_EFFORT = ["low", "medium", "high"] as const;

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);
  const allFlag = rest.includes("--all");
  const archivedFlag = rest.includes("--archived");

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

  const columnFilters = collectRepeated(rest, "--column");
  const attendanceFilter = getFlagValue(rest, "--attendance");
  const effortFilter = getFlagValue(rest, "--effort");

  for (const col of columnFilters) {
    if (!COLUMNS.includes(col)) {
      const msg = `unknown column: ${col}. Valid columns: ${COLUMNS.join(", ")}`;
      emit({ ok: false, code: "UNKNOWN_COLUMN", message: msg, details: { column: col, valid: COLUMNS } }, ctx);
    }
  }

  if (attendanceFilter !== undefined) {
    validateEnumOrExit("--attendance", attendanceFilter, VALID_ATTENDANCE, ctx, "INVALID_ATTENDANCE");
  }
  if (effortFilter !== undefined) {
    validateEnumOrExit("--effort", effortFilter, VALID_EFFORT, ctx, "INVALID_EFFORT");
  }

  const dir = resolveStoreDir(process.cwd());

  if (!existsSync(dir)) {
    const msg = "store not initialized; run `tasks new` to create it";
    emit({ ok: false, code: "NOT_INITIALIZED", message: msg }, ctx);
  }

  const liveTasks = findAllTasks(dir);
  const archivedTasks = findArchivedTasks(dir);
  // computeBlockedBy needs both so that an archived dep does not show as a
  // blocker on a live task; the dangling-vs-complete distinction matters.
  const blockedBy = computeBlockedBy([...liveTasks, ...archivedTasks]);
  let tasks = archivedFlag
    ? archivedTasks
    : applyDoneCutoff(liveTasks, allFlag, sinceDays);

  if (columnFilters.length > 0) {
    tasks = tasks.filter((t) => columnFilters.includes(t.column));
  }
  if (attendanceFilter !== undefined) {
    tasks = tasks.filter((t) => t.attendance === attendanceFilter);
  }
  if (effortFilter !== undefined) {
    tasks = tasks.filter((t) => t.effort === effortFilter);
  }

  const decorated = tasks.map((t) => ({
    ...withAcceptanceCriteria(t),
    blockedBy: blockedBy.get(t.uuid) ?? [],
  }));
  emit(
    {
      ok: true,
      json: decorated,
      text: (c) => renderList(tasks, { color: c.color, blockedBy }),
    },
    ctx,
  );
}
