import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse, parseDocument, type Document } from "yaml";
import { git } from "./git.ts";
import { COLUMNS } from "./constants.ts";
import type { TaskData } from "./types.ts";

/**
 * Convert a title to a URL/filename slug.
 * Lowercase, replace runs of non-alphanumeric chars with `-`, trim dashes.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Parse a task file's raw content into frontmatter + body.
 * Body is everything after the closing `---` line, with exactly one leading
 * newline stripped (so a freshly created task with `---\n` at the end yields "").
 */
export function parseTaskFile(content: string): { fm: Record<string, unknown>; body: string } {
  // Split on the second `---` delimiter
  const parts = content.split(/^---\s*$/m);
  // parts[0] is empty (before the first ---), parts[1] is frontmatter, parts[2+] is body
  if (parts.length < 3) {
    return { fm: {}, body: "" };
  }
  const fm = yamlParse(parts[1]) as Record<string, unknown>;
  // Join remaining parts (in case body itself contained ---)
  const rawBody = parts.slice(2).join("---");
  // Strip exactly one leading newline
  const body = rawBody.startsWith("\n") ? rawBody.slice(1) : rawBody;
  return { fm, body };
}

/** Current UTC timestamp in ISO 8601 (the canonical created_at/updated_at form). */
function nowISO(): string {
  return new Date().toISOString();
}

/**
 * A loaded task file. Wraps the parsed frontmatter `Document` and the verbatim
 * body, tracks where the file currently lives on disk, and computes the slug
 * filename the task should have given its current title. Assign `.column` to
 * relocate the task; call `.set("title", ...)` to trigger a slug rename. Holds
 * no git knowledge — `commitTaskChange` owns the git dance.
 */
class TaskFile {
  readonly dir: string;
  readonly origColumn: string;
  readonly origFilename: string;
  /** Target column; assign to move the task to a different column. */
  column: string;
  private readonly doc: Document;
  /** Everything after the closing `---` delimiter, preserved verbatim. */
  private readonly bodyRaw: string;
  private titleChanged = false;

  constructor(dir: string, column: string, filename: string, doc: Document, bodyRaw: string) {
    this.dir = dir;
    this.origColumn = column;
    this.origFilename = filename;
    this.column = column;
    this.doc = doc;
    this.bodyRaw = bodyRaw;
  }

  get id(): number {
    return this.doc.get("id") as number;
  }
  get uuid(): string {
    return String(this.doc.get("uuid"));
  }
  get title(): string {
    return this.doc.get("title") as string;
  }

  get(key: string): unknown {
    return this.doc.get(key);
  }

  set(key: string, value: unknown): void {
    this.doc.set(key, value);
    if (key === "title") this.titleChanged = true;
  }

  /** The on-disk filename this task should have given its current title. */
  targetFilename(): string {
    if (!this.titleChanged) return this.origFilename;
    return `${this.id}-${slugify(this.title)}.md`;
  }

  get origRelPath(): string {
    return `${this.origColumn}/${this.origFilename}`;
  }
  get targetRelPath(): string {
    return `${this.column}/${this.targetFilename()}`;
  }

  serialize(): string {
    return `---\n${this.doc.toString()}---${this.bodyRaw}`;
  }
}

/** Read the file at `column/filename` into a TaskFile handle (no resolution). */
function readTaskFileAt(dir: string, column: string, filename: string): TaskFile {
  const raw = readFileSync(join(dir, column, filename), "utf-8");
  const parts = raw.split(/^---\s*$/m);
  const doc = parseDocument(parts[1] ?? "");
  const bodyRaw = parts.slice(2).join("---");
  return new TaskFile(dir, column, filename, doc, bodyRaw);
}

/**
 * Resolve a Short ID or UUID to its on-disk file and load it. Returns null if
 * the task does not exist. Scans all columns (via `findTaskFilename`).
 */
export function loadTaskFile(dir: string, ref: string): TaskFile | null {
  const loc = findTaskFilename(dir, ref);
  if (!loc) return null;
  return readTaskFileAt(dir, loc.column, loc.filename);
}

/** Canonical frontmatter fields for a brand-new task. */
interface NewTaskFields {
  id: number;
  uuid: string;
  title: string;
  deps: string[];
  attendance: string;
  effort: string;
  created_at: string;
  updated_at: string;
}

/**
 * Build an in-memory TaskFile for a brand-new task (no file on disk yet),
 * writing the canonical frontmatter field order in exactly one place. The
 * caller serializes it for the initial write and owns the git/commit dance.
 */
export function newTaskFile(
  dir: string,
  column: string,
  filename: string,
  fields: NewTaskFields,
  body: string,
): TaskFile {
  const doc = parseDocument("");
  doc.set("id", fields.id);
  doc.set("uuid", fields.uuid);
  doc.set("title", fields.title);
  doc.set("deps", fields.deps);
  doc.set("attendance", fields.attendance);
  doc.set("effort", fields.effort);
  doc.set("created_at", fields.created_at);
  doc.set("updated_at", fields.updated_at);
  return new TaskFile(dir, column, filename, doc, `\n${body}`);
}

/**
 * Load the file for an already-resolved TaskData, scanning only its known
 * column so multi-file mutations don't re-scan the whole store. Returns null if
 * the file can no longer be found (e.g. moved out from under us).
 */
export function loadTaskFileAt(dir: string, task: TaskData): TaskFile | null {
  const colDir = join(dir, task.column);
  if (!existsSync(colDir)) return null;
  for (const f of readdirSync(colDir).filter((n) => n.endsWith(".md"))) {
    const raw = readFileSync(join(colDir, f), "utf-8");
    const parts = raw.split(/^---\s*$/m);
    if (parts.length < 3) continue;
    const fm = yamlParse(parts[1]) as Record<string, unknown>;
    if (fm.uuid === task.uuid) {
      return readTaskFileAt(dir, task.column, f);
    }
  }
  return null;
}

/**
 * Bump `updated_at`, write the (possibly renamed/relocated) TaskFile to disk,
 * and stage it. When the target path differs from the origin (slug change or
 * column move) the rename goes through `git mv` so history follows the file.
 * Does NOT commit — callers commit, so multi-file mutations can stage several
 * files into a single commit.
 */
export async function stageTaskFile(tf: TaskFile): Promise<void> {
  tf.set("updated_at", nowISO());
  const origPath = join(tf.dir, tf.origColumn, tf.origFilename);
  writeFileSync(origPath, tf.serialize(), "utf-8");
  await git(["add", tf.origRelPath], tf.dir);
  if (tf.origRelPath !== tf.targetRelPath) {
    const mvExit = await git(["mv", tf.origRelPath, tf.targetRelPath], tf.dir);
    if (mvExit !== 0) {
      // Fallback: manual rename + add/rm (mirrors the prior setTask/editTask path).
      renameSync(origPath, join(tf.dir, tf.targetRelPath));
      await git(["rm", tf.origRelPath], tf.dir);
      await git(["add", tf.targetRelPath], tf.dir);
    }
  }
}

/** Stage a single TaskFile change and commit it in exactly one commit. */
export async function commitTaskChange(tf: TaskFile, message: string): Promise<void> {
  await stageTaskFile(tf);
  await git(["commit", "-m", message], tf.dir);
}

/**
 * Locate the on-disk filename for a task by short id or UUID.
 * Returns null if not found.
 */
export function findTaskFilename(
  dir: string,
  idOrUuid: string,
): { column: string; filename: string } | null {
  if (!existsSync(dir)) return null;
  const byShortId = /^\d+$/.test(idOrUuid);
  const targetId = byShortId ? parseInt(idOrUuid, 10) : null;
  for (const col of COLUMNS) {
    const colDir = join(dir, col);
    if (!existsSync(colDir)) continue;
    let files: string[];
    try {
      files = readdirSync(colDir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const raw = readFileSync(join(colDir, f), "utf-8");
      const parts = raw.split(/^---\s*$/m);
      if (parts.length < 3) continue;
      const fm = yamlParse(parts[1]) as Record<string, unknown>;
      const matches = byShortId ? fm.id === targetId : fm.uuid === idOrUuid;
      if (matches) return { column: col, filename: f };
    }
  }
  return null;
}

/**
 * Compute the on-disk slug for a title (exposed for `edit` so renames stay in
 * sync with `new`).
 */
export function titleSlug(title: string): string {
  return slugify(title);
}
