import { existsSync } from "node:fs";
import {
  COLUMNS,
  findAllTasks,
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

  const tasksOut: ExportedLiveTask[] = ordered.map(toLiveExport);

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
