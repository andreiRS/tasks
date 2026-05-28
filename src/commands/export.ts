import { existsSync } from "node:fs";
import {
  COLUMNS,
  findAllTasks,
  findArchivedTasks,
  resolveStoreDir,
  type TaskData,
} from "../store.ts";
import { writeJsonError, writePlainError } from "../cli/errors.ts";
import { parseAcceptanceCriteria } from "../acceptance.ts";

const SCHEMA_VERSION = "1";

/**
 * Capture `git rev-parse HEAD` for the given store dir. Returns the trimmed
 * SHA, or throws on git failure.
 */
async function readHeadSha(dir: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (code !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

interface ExportedLiveTask {
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
  acceptance_criteria: string;
}

interface ArchiveStub {
  id: number;
  uuid: string;
  title: string;
  column: "archive";
  complete: true;
}

function toArchiveStub(task: TaskData): ArchiveStub {
  return {
    id: task.id,
    uuid: task.uuid,
    title: task.title,
    column: "archive",
    complete: true,
  };
}

function toLiveExport(task: TaskData): ExportedLiveTask {
  return {
    id: task.id,
    uuid: task.uuid,
    title: task.title,
    column: task.column,
    created_at: task.created_at,
    updated_at: task.updated_at,
    body: task.body,
    deps: task.deps,
    attendance: task.attendance,
    effort: task.effort,
    acceptance_criteria: parseAcceptanceCriteria(task.body),
  };
}

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");

  if (!jsonFlag) {
    writePlainError("MISSING_FIELD: tasks export requires --json");
    process.exit(1);
  }

  const dir = resolveStoreDir(process.cwd());
  if (!existsSync(dir)) {
    writeJsonError(
      "NOT_INITIALIZED",
      "store not initialized; run `tasks init` to create it",
      {},
    );
    process.exit(1);
  }

  const liveTasks = findAllTasks(dir);

  // Group by Column in the fixed COLUMNS order, then sort each bucket by
  // `created_at` ascending. The export contract guarantees this ordering so
  // diffs across invocations are stable.
  const grouped: Record<string, TaskData[]> = {};
  for (const col of COLUMNS) grouped[col] = [];
  for (const t of liveTasks) {
    if (grouped[t.column]) grouped[t.column].push(t);
  }
  const ordered: TaskData[] = [];
  for (const col of COLUMNS) {
    grouped[col].sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      if (ta !== tb) return ta - tb;
      return a.id - b.id;
    });
    ordered.push(...grouped[col]);
  }

  const tasksOut: Array<ExportedLiveTask | ArchiveStub> = ordered.map(toLiveExport);

  // Archive Stubs: for any Archived Task that is referenced as a Dep by a
  // live Task, emit a minimal record after the live tasks so the Dep graph
  // is never dangling. The full Archive is excluded by default.
  const archivedTasks = findArchivedTasks(dir);
  const archivedByUuid = new Map(archivedTasks.map((t) => [t.uuid, t]));
  const referencedArchivedUuids = new Set<string>();
  for (const t of ordered) {
    for (const depUuid of t.deps) {
      if (archivedByUuid.has(depUuid)) {
        referencedArchivedUuids.add(depUuid);
      }
    }
  }
  if (referencedArchivedUuids.size > 0) {
    const stubs = archivedTasks
      .filter((t) => referencedArchivedUuids.has(t.uuid))
      .sort((a, b) => a.id - b.id)
      .map(toArchiveStub);
    tasksOut.push(...stubs);
  }

  // Reverse-dep index: for every live task with deps [B, C], record this
  // task's uuid under reverse_deps[B] and reverse_deps[C]. Computed from
  // live forward `deps` only.
  const reverseDeps: Record<string, string[]> = {};
  for (const t of liveTasks) {
    for (const depUuid of t.deps) {
      if (!reverseDeps[depUuid]) reverseDeps[depUuid] = [];
      reverseDeps[depUuid].push(t.uuid);
    }
  }
  for (const uuid of Object.keys(reverseDeps)) {
    reverseDeps[uuid].sort();
  }

  const headSha = await readHeadSha(dir);

  const envelope = {
    ok: true,
    schema_version: SCHEMA_VERSION,
    head_sha: headSha,
    tasks: tasksOut,
    reverse_deps: reverseDeps,
  };

  process.stdout.write(JSON.stringify(envelope) + "\n");
}
