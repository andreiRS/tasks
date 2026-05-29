import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitCommit } from "./git.ts";
import { COLUMNS, ARCHIVE_DIR } from "./constants.ts";

/**
 * Ensure the store at `dir` exists and is initialized.
 * If it doesn't exist yet, creates it, runs `git init`, creates an empty
 * initial commit, creates the six column directories, and prints an init
 * notice to stderr.
 *
 * Returns true if the store was freshly initialized, false if it already existed.
 */
export async function ensureStore(dir: string): Promise<boolean> {
  if (existsSync(join(dir, ".git"))) {
    await upsertGitignore(dir);
    return false;
  }

  // Create the store directory and column subdirectories
  mkdirSync(dir, { recursive: true });
  for (const col of COLUMNS) {
    mkdirSync(join(dir, col), { recursive: true });
  }
  mkdirSync(join(dir, ARCHIVE_DIR), { recursive: true });

  // git init
  await git(["init"], dir);

  writeFileSync(join(dir, ".gitignore"), STORE_GITIGNORE, "utf-8");
  await git(["add", ".gitignore"], dir);

  // Initial commit (includes .gitignore)
  await gitCommit(dir, "init");

  process.stderr.write(`tasks: initialized store at ${dir}\n`);
  return true;
}

/**
 * Explicitly initialize the store at `dir`.
 *
 * Functionally identical to `ensureStore` but ALSO creates `meta.yaml` with
 * `next_id: 1` and includes it in the initial seed commit, so the store is
 * fully usable after `tasks init` without waiting for the first `tasks new`.
 *
 * Idempotent: when the store already exists (`.git` present) this returns
 * immediately with `created: false` and does NOT re-init, re-commit, or
 * overwrite anything.
 *
 * Returns `{ created: boolean; path: string }`.
 */
export async function initStore(dir: string): Promise<{ created: boolean; path: string }> {
  if (existsSync(join(dir, ".git"))) {
    return { created: false, path: dir };
  }

  // Create the store directory and column subdirectories
  mkdirSync(dir, { recursive: true });
  for (const col of COLUMNS) {
    mkdirSync(join(dir, col), { recursive: true });
  }
  mkdirSync(join(dir, ARCHIVE_DIR), { recursive: true });

  // git init
  await git(["init"], dir);

  // Write .gitignore and meta.yaml, stage both, then initial commit
  writeFileSync(join(dir, ".gitignore"), STORE_GITIGNORE, "utf-8");
  writeFileSync(join(dir, "meta.yaml"), "next_id: 1\n", "utf-8");
  await git(["add", ".gitignore", "meta.yaml"], dir);
  await gitCommit(dir, "init");

  process.stderr.write(`tasks: initialized store at ${dir}\n`);
  return { created: true, path: dir };
}

/**
 * Canonical store `.gitignore`. The lock file is required (flock(1) needs a
 * real on-disk file but it must not be tracked). The remaining patterns
 * cover editor droppings that would otherwise leave the store dirty after
 * an `edit` and trip the STORE_DIRTY guard on the next mutating command.
 */
const STORE_GITIGNORE = [
  ".tasks-lock",
  "",
  "# Editor droppings",
  ".*.sw?",     // vim swap (.foo.swp, .foo.swo, …)
  "*~",         // emacs/nano backup
  ".#*",        // emacs lockfile
  "*.bak",
  "*.orig",
  "",
  "# OS junk",
  ".DS_Store",
  "Thumbs.db",
  "",
].join("\n");

/**
 * Idempotently ensure the store's `.gitignore` matches the canonical
 * content. If the file is missing or differs, write it and commit just
 * that path so a pre-existing dirty tree elsewhere is not touched.
 */
async function upsertGitignore(dir: string): Promise<void> {
  const path = join(dir, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (current === STORE_GITIGNORE) return;
  writeFileSync(path, STORE_GITIGNORE, "utf-8");
  await git(["add", ".gitignore"], dir);
  await gitCommit(dir, "store: refresh .gitignore", ["--", ".gitignore"]);
}
