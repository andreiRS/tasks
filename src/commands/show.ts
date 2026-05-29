import { findAllTasks, findArchivedTasks, findTask, resolveStoreDir, type TaskData } from "../store.ts";
import { renderTask } from "../render.ts";
import { emit, outputContext } from "../cli/output.ts";
import { shouldColor } from "../cli/color.ts";
import { withAcceptanceCriteria } from "../cli/filters.ts";

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);
  const noColorFlag = rest.includes("--no-color");
  const idOrUuid = rest.find((a) => a !== "--json" && a !== "--no-color") ?? "";

  if (!idOrUuid) {
    emit({ ok: false, code: "MISSING_FIELD", message: "id or uuid is required" }, ctx);
  }

  const dir = resolveStoreDir(process.cwd());
  // Fall back to archive/ so retired tasks remain inspectable. mv/rm intentionally
  // do NOT see archived tasks (archive is one-way; ADR-0010).
  const byShortId = /^\d+$/.test(idOrUuid);
  const targetId = byShortId ? parseInt(idOrUuid, 10) : null;
  const task =
    findTask(dir, idOrUuid) ??
    findArchivedTasks(dir).find((t) => (byShortId ? t.id === targetId : t.uuid === idOrUuid)) ??
    null;

  if (!task) {
    emit({ ok: false, code: "NOT_FOUND", message: `task not found: ${idOrUuid}`, details: { id: idOrUuid } }, ctx);
  }

  // Include archived tasks so deps to retired blockers resolve to "#id title"
  // instead of "<unknown>". Archived tasks count as Complete (ADR-0010).
  const allTasks = [...findAllTasks(dir), ...findArchivedTasks(dir)];
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
