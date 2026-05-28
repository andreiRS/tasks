import { existsSync } from "node:fs";
import {
  COLUMNS,
  findAllTasks,
  findArchivedTasks,
  resolveStoreDir,
  type TaskData,
} from "../store.ts";
import { writeJsonError, writePlainError } from "../cli/errors.ts";
import { getFlagValue } from "../cli/args.ts";
import { parseSinceDays } from "../cli/validation.ts";

const SCHEMA_VERSION = "1";
const DEFAULT_RECENT = 10;
const DEFAULT_STALE_DAYS = 14;

/** Columns that can go stale. */
const STALE_COLUMNS = new Set(["doing", "blocked", "review"]);

interface TaskStub {
  id: number;
  uuid: string;
  title: string;
  column: string;
  updated_at: string;
}

function toStub(task: TaskData): TaskStub {
  return {
    id: task.id,
    uuid: task.uuid,
    title: task.title,
    column: task.column,
    updated_at: task.updated_at,
  };
}

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
    throw new Error(
      `git rev-parse HEAD failed: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout.trim();
}

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");

  if (!jsonFlag) {
    writePlainError("MISSING_FIELD: tasks summary requires --json");
    process.exit(1);
  }

  // Parse --recent N
  let recentCount = DEFAULT_RECENT;
  const recentVal = getFlagValue(rest, "--recent");
  if (recentVal !== undefined) {
    const parsed = parseInt(recentVal, 10);
    if (!Number.isInteger(parsed) || isNaN(parsed) || parsed <= 0 || String(parsed) !== recentVal) {
      writeJsonError(
        "INVALID_ARG",
        `invalid --recent value: ${recentVal}. Expected a positive integer`,
        { value: recentVal },
      );
      process.exit(1);
    }
    recentCount = parsed;
  }

  // Parse --stale <duration>
  let staleDays = DEFAULT_STALE_DAYS;
  const staleVal = getFlagValue(rest, "--stale");
  if (staleVal !== undefined) {
    const parsed = parseSinceDays(staleVal);
    if (parsed === null) {
      writeJsonError(
        "INVALID_ARG",
        `invalid --stale value: ${staleVal}. Expected format: <N>d (e.g. 14d, 30d)`,
        { value: staleVal },
      );
      process.exit(1);
    }
    staleDays = parsed;
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
  const archivedTasks = findArchivedTasks(dir);

  // Build counts: one entry per live column + archive.
  const counts: Record<string, number> = {};
  for (const col of COLUMNS) {
    counts[col] = 0;
  }
  counts.archive = 0;
  for (const t of liveTasks) {
    if (counts[t.column] !== undefined) {
      counts[t.column]++;
    }
  }
  counts.archive = archivedTasks.length;

  // Build recent: top N live tasks by updated_at desc; tiebreak by id desc.
  const sortedByRecent = [...liveTasks].sort((a, b) => {
    const ta = new Date(a.updated_at).getTime();
    const tb = new Date(b.updated_at).getTime();
    if (ta !== tb) return tb - ta; // descending
    return b.id - a.id; // tiebreak: id descending
  });
  const recent = sortedByRecent.slice(0, recentCount).map(toStub);

  // Build stale: live tasks in doing/blocked/review whose updated_at is
  // older than staleDays from now, sorted by updated_at ascending (oldest first).
  const now = Date.now();
  const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const stale = liveTasks
    .filter((t) => {
      if (!STALE_COLUMNS.has(t.column)) return false;
      const age = now - new Date(t.updated_at).getTime();
      return age > staleThresholdMs;
    })
    .sort((a, b) => {
      const ta = new Date(a.updated_at).getTime();
      const tb = new Date(b.updated_at).getTime();
      if (ta !== tb) return ta - tb; // ascending (oldest first)
      return a.id - b.id; // tiebreak: id ascending
    })
    .map(toStub);

  const headSha = await readHeadSha(dir);

  const envelope = {
    ok: true,
    schema_version: SCHEMA_VERSION,
    head_sha: headSha,
    counts,
    recent,
    stale,
  };

  process.stdout.write(JSON.stringify(envelope) + "\n");
}
