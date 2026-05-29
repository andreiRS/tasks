import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { COLUMNS, resolveStoreDir } from "../store.ts";
import { emit, outputContext, type OutputContext } from "../cli/output.ts";

/**
 * `tasks doctor` — read-only store diagnostics, plus `--clean` recovery.
 *
 * Report mode (no flags):
 *   - Absolute store path.
 *   - `git status --short` of the store.
 *   - Count of outstanding stashes in the store.
 *
 * `--clean`:
 *   - Runs `git stash push --include-untracked --message "doctor <iso-ts>"`
 *     inside the store. Stashes everything (modified tracked files,
 *     untracked files, editor strays) so the working tree is clean.
 *   - Dirty tree → prints the new stash ref and store path so the user can
 *     `cd <path> && git stash pop` to recover.
 *   - Clean tree → prints `store already clean`. No stash is created.
 *
 * Always exits 0. Does NOT take the flock. Does NOT validate schema.
 * Never deletes files. See ADR-0009.
 *
 * `--json` is opt-in (never auto-switches on non-TTY stdout), mirroring
 * other read commands. JSON shapes:
 *   Report:        { store, status: [{ code, path }, ...], stashes }
 *   Clean (dirty): { store, stashed: true, stash_ref }
 *   Clean (clean): { store, stashed: false, already_clean: true }
 */
export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);
  const clean = rest.includes("--clean");
  const dir = resolveStoreDir(process.cwd());
  const hasStore = existsSync(join(dir, ".git"));

  if (clean) {
    await runClean(dir, hasStore, ctx);
    return;
  }

  await runReport(dir, hasStore, ctx);
}

async function runReport(dir: string, hasStore: boolean, ctx: OutputContext): Promise<void> {
  let status = "";
  let stashes = 0;

  if (hasStore) {
    status = await gitOut(dir, ["status", "--short"]);
    const stashList = await gitOut(dir, ["stash", "list"]);
    stashes = stashList === "" ? 0 : stashList.split("\n").filter((l) => l.length > 0).length;
  }

  const statusEntries = parseStatusShort(status);

  emit(
    {
      ok: true,
      json: { store: dir, status: statusEntries, stashes },
      text: () => {
        const out: string[] = [];
        out.push(`store: ${dir}`);
        if (!hasStore) {
          out.push("status: (store not initialised)");
        } else {
          out.push("status:");
          if (status.length > 0) {
            for (const line of status.split("\n")) {
              if (line.length > 0) out.push(line);
            }
          }
        }
        out.push(`stashes: ${stashes}`);
        return out.join("\n") + "\n";
      },
    },
    ctx,
  );
}

async function runClean(dir: string, hasStore: boolean, ctx: OutputContext): Promise<void> {
  if (!hasStore) {
    emit(
      {
        ok: true,
        json: { store: dir, stashed: false, already_clean: true },
        text: () => `store: ${dir}\nstore already clean\n`,
      },
      ctx,
    );
  }

  const status = await gitOut(dir, ["status", "--short"]);
  if (status.length === 0) {
    emit(
      {
        ok: true,
        json: { store: dir, stashed: false, already_clean: true },
        text: () => `store: ${dir}\nstore already clean\n`,
      },
      ctx,
    );
  }

  const ts = new Date().toISOString();
  const proc = Bun.spawn(
    ["git", "-C", dir, "stash", "push", "--include-untracked", "--message", `doctor ${ts}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;

  // `git stash --include-untracked` removes empty column directories (git
  // does not track empty dirs, so they get swept). Recreate the canonical
  // column layout so subsequent mutating commands like `tasks new` find the
  // directories they expect; this does not dirty the tree because empty
  // dirs are invisible to git.
  for (const col of COLUMNS) {
    mkdirSync(join(dir, col), { recursive: true });
  }

  // After a successful stash, the new entry is at stash@{0}.
  emit(
    {
      ok: true,
      json: { store: dir, stashed: true, stash_ref: "stash@{0}" },
      text: () => {
        const out: string[] = [];
        out.push(`store: ${dir}`);
        out.push("stashed: stash@{0}");
        out.push("recover with: cd " + dir + " && git stash pop");
        return out.join("\n") + "\n";
      },
    },
    ctx,
  );
}

/**
 * Parse the output of `git status --short` into `{ code, path }` entries.
 * `code` is the verbatim first two characters (preserving spaces). The
 * path begins at column 3 (one space separator between code and path is
 * part of porcelain v1 layout but consumed here). Lines shorter than 3
 * chars are ignored.
 *
 * Note: this does not attempt to handle renames (`R  old -> new`) as a
 * structured pair; the right-hand path is fine to pass through as-is for
 * diagnostic purposes.
 */
function parseStatusShort(status: string): { code: string; path: string }[] {
  if (status.length === 0) return [];
  const entries: { code: string; path: string }[] = [];
  for (const line of status.split("\n")) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    entries.push({ code, path });
  }
  return entries;
}

/**
 * Run `git -C <dir> <args>` and return its stdout (trimmed of trailing
 * newline). Returns "" on non-zero exit so callers can treat git failures
 * as a benign empty report — doctor must never throw.
 */
async function gitOut(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (code !== 0) return "";
  return stdout.replace(/\n$/, "");
}
