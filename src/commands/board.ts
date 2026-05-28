import { existsSync } from "node:fs";
import { findAllTasks, groupTasksByColumn, resolveStoreDir, type TaskData } from "../store.ts";
import { renderBoard, computeBlockedBy } from "../render.ts";
import { writeJsonError, writePlainError } from "../cli/errors.ts";
import { shouldColor } from "../cli/color.ts";
import { applyDoneCutoff, withAcceptanceCriteria } from "../cli/filters.ts";
import { parseSinceDays } from "../cli/validation.ts";
import { getFlagValue } from "../cli/args.ts";

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

  const allTasks = findAllTasks(dir);
  const blockedBy = computeBlockedBy(allTasks);
  const tasks = applyDoneCutoff(allTasks, allFlag, sinceDays);

  const grouped = groupTasksByColumn(tasks);

  if (jsonFlag) {
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
    process.stdout.write(JSON.stringify(groupedWithAc) + "\n");
  } else {
    process.stdout.write(renderBoard(grouped, { color: shouldColor(noColorFlag), blockedBy }));
  }
}
