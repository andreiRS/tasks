import { existsSync } from "node:fs";
import { findAllTasks, findArchivedTasks, resolveStoreDir, type TaskData } from "../store.ts";
import { renderTask } from "../render.ts";
import { emit, outputContext } from "../cli/output.ts";
import { shouldColor } from "../cli/color.ts";
import { withAcceptanceCriteria } from "../cli/filters.ts";
import { validateEnumOrExit } from "../cli/validation.ts";
import { getFlagValue } from "../cli/args.ts";

const VALID_ATTENDANCE = ["attended", "unattended"] as const;

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);
  const noColorFlag = rest.includes("--no-color");
  const unattendedFlag = rest.includes("--unattended");

  const attendanceFilter = getFlagValue(rest, "--attendance");

  if (unattendedFlag && attendanceFilter !== undefined && attendanceFilter !== "unattended") {
    const msg = `conflict: --unattended and --attendance ${attendanceFilter} are contradictory; --unattended means --attendance unattended`;
    emit({ ok: false, code: "CONFLICT", message: msg, details: { unattended: true, attendance: attendanceFilter } }, ctx);
  }

  if (attendanceFilter !== undefined) {
    validateEnumOrExit("--attendance", attendanceFilter, VALID_ATTENDANCE, ctx, "INVALID_ATTENDANCE");
  }

  const effectiveAttendance: string | undefined = unattendedFlag ? "unattended" : attendanceFilter;

  const dir = resolveStoreDir(process.cwd());

  if (!existsSync(dir)) {
    const msg = "no ready task found";
    emit({ ok: false, code: "NO_READY_TASK", message: msg }, ctx);
  }

  const liveTasks = findAllTasks(dir);
  const archivedTasks = findArchivedTasks(dir);
  const allTasks = [...liveTasks, ...archivedTasks];
  // Archived tasks count as Complete for blocking purposes (see ADR-0010).
  const completeUuids = new Set([
    ...liveTasks.filter((t) => t.column === "done").map((t) => t.uuid),
    ...archivedTasks.map((t) => t.uuid),
  ]);

  let candidates = liveTasks.filter((t) => {
    if (t.column !== "ready") return false;
    return t.deps.every((depUuid) => completeUuids.has(depUuid));
  });

  if (effectiveAttendance !== undefined) {
    candidates = candidates.filter((t) => t.attendance === effectiveAttendance);
  }

  if (candidates.length === 0) {
    const msg = "no ready task found";
    emit({ ok: false, code: "NO_READY_TASK", message: msg }, ctx);
  }

  candidates.sort((a, b) => {
    const tA = new Date(a.created_at).getTime();
    const tB = new Date(b.created_at).getTime();
    if (tA !== tB) return tA - tB;
    return a.id - b.id;
  });

  const task = candidates[0];

  const byUuid = new Map<string, TaskData>(allTasks.map((t) => [t.uuid, t]));
  const deps_out = task.deps
    .map((u) => byUuid.get(u))
    .filter((t): t is TaskData => t !== undefined)
    .map((t) => ({ uuid: t.uuid, id: t.id, title: t.title }));
  const deps_in = allTasks
    .filter((t) => t.deps.includes(task.uuid))
    .sort((a, b) => a.id - b.id)
    .map((t) => ({ uuid: t.uuid, id: t.id, title: t.title }));

  if (ctx.json) {
    process.stdout.write(JSON.stringify({ ...withAcceptanceCriteria(task), deps_out, deps_in }) + "\n");
  } else {
    process.stdout.write(renderTask(task, { color: shouldColor(noColorFlag), deps_out, deps_in }));
  }
}
