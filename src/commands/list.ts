import { existsSync } from "node:fs";
import { COLUMNS, findAllTasks, resolveStoreDir } from "../store.ts";
import { renderList } from "../render.ts";
import { writeJsonError, writePlainError } from "../cli/errors.ts";
import { shouldColor } from "../cli/color.ts";
import { applyDoneCutoff, withAcceptanceCriteria } from "../cli/filters.ts";
import { parseSinceDays, validateEnumOrExit } from "../cli/validation.ts";
import { collectRepeated, getFlagValue } from "../cli/args.ts";

const VALID_ATTENDANCE = ["attended", "unattended"] as const;
const VALID_EFFORT = ["low", "medium", "high"] as const;

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");
  const noColorFlag = rest.includes("--no-color");
  const allFlag = rest.includes("--all");

  let sinceDays = 7;
  const sinceVal = getFlagValue(rest, "--since");
  if (sinceVal !== undefined) {
    const parsed = parseSinceDays(sinceVal);
    if (parsed === null) {
      const msg = `invalid --since value: ${sinceVal}. Expected format: <N>d (e.g. 7d, 30d)`;
      if (jsonFlag) {
        writeJsonError("INVALID_SINCE", msg, { value: sinceVal });
      } else {
        writePlainError(`INVALID_SINCE: ${msg}`);
      }
      process.exit(1);
    }
    sinceDays = parsed;
  }

  const columnFilters = collectRepeated(rest, "--column");
  const attendanceFilter = getFlagValue(rest, "--attendance");
  const effortFilter = getFlagValue(rest, "--effort");

  for (const col of columnFilters) {
    if (!COLUMNS.includes(col)) {
      const msg = `unknown column: ${col}. Valid columns: ${COLUMNS.join(", ")}`;
      if (jsonFlag) {
        writeJsonError("UNKNOWN_COLUMN", msg, { column: col, valid: COLUMNS });
      } else {
        writePlainError(`UNKNOWN_COLUMN: ${msg}`);
      }
      process.exit(1);
    }
  }

  if (attendanceFilter !== undefined) {
    validateEnumOrExit("--attendance", attendanceFilter, VALID_ATTENDANCE, jsonFlag, "INVALID_ATTENDANCE");
  }
  if (effortFilter !== undefined) {
    validateEnumOrExit("--effort", effortFilter, VALID_EFFORT, jsonFlag, "INVALID_EFFORT");
  }

  const dir = resolveStoreDir(process.cwd());

  if (!existsSync(dir)) {
    const msg = "store not initialized; run `tasks new` to create it";
    if (jsonFlag) {
      writeJsonError("NOT_INITIALIZED", msg, {});
    } else {
      writePlainError(`NOT_INITIALIZED: ${msg}`);
    }
    process.exit(1);
  }

  let tasks = findAllTasks(dir);
  tasks = applyDoneCutoff(tasks, allFlag, sinceDays);

  if (columnFilters.length > 0) {
    tasks = tasks.filter((t) => columnFilters.includes(t.column));
  }
  if (attendanceFilter !== undefined) {
    tasks = tasks.filter((t) => t.attendance === attendanceFilter);
  }
  if (effortFilter !== undefined) {
    tasks = tasks.filter((t) => t.effort === effortFilter);
  }

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(tasks.map(withAcceptanceCriteria)) + "\n");
  } else {
    process.stdout.write(renderList(tasks, { color: shouldColor(noColorFlag) }));
  }
}
