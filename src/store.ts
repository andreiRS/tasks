import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as yamlParse } from "yaml";

import { TasksError } from "./errors.ts";
import { encodePath, storeDir, resolveStoreDir } from "./paths.ts";
import { git, gitCapture, gitCommit, identityArgs } from "./git.ts";
import {
  COLUMNS,
  ARCHIVE_DIR,
  ATTENDANCE_VALUES,
  EFFORT_VALUES,
  DEFAULT_ATTENDANCE,
  DEFAULT_EFFORT,
} from "./constants.ts";
import type { TaskData, EditorRunner } from "./types.ts";
import {
  resolveAttendance,
  resolveEffort,
  validateEnums,
  validateTitle,
  validateGraph,
} from "./validation.ts";
import { nowISO } from "./clock.ts";
import { ensureStore, initStore } from "./store-init.ts";
import { findFlockOrFail, isStoreDirty, withTransaction } from "./lock.ts";
import {
  slugify,
  titleSlug,
  newTaskFile,
  loadTaskFile,
  loadTaskFileAt,
  stageTaskFile,
  commitTaskChange,
  findTaskFilename,
} from "./task-file.ts";
import {
  findAllTasks,
  findArchivedTasks,
  findTask,
  groupTasksByColumn,
} from "./queries.ts";

// Re-export barrel: keep the public surface importable from "../store" so
// consumers in src/commands/* and src/cli* need no changes after the split.
export { TasksError } from "./errors.ts";
export { encodePath, storeDir, resolveStoreDir } from "./paths.ts";
export {
  COLUMNS,
  ARCHIVE_DIR,
  ATTENDANCE_VALUES,
  EFFORT_VALUES,
  DEFAULT_ATTENDANCE,
  DEFAULT_EFFORT,
} from "./constants.ts";
export type { TaskData, EditorRunner } from "./types.ts";
export { validateEnums, validateTitle, validateGraph } from "./validation.ts";
export { ensureStore, initStore } from "./store-init.ts";
export { findFlockOrFail, isStoreDirty } from "./lock.ts";
export { titleSlug, findTaskFilename } from "./task-file.ts";
export { findAllTasks, findArchivedTasks, findTask, groupTasksByColumn } from "./queries.ts";

export interface CreateTaskOptions {
  attendance?: "attended" | "unattended";
  effort?: "low" | "medium" | "high";
  /** UUIDs of tasks this task depends on (already resolved and validated by caller). */
  deps?: string[];
  /** Body text to write after the frontmatter. */
  body?: string;
  /**
   * Optional editor runner. When provided, the editor is opened on the task
   * file after creation and the file is re-validated/recommitted if changed.
   * Returns the on-disk outcome for the caller.
   */
  runEditor?: EditorRunner;
}

/**
 * Create a new task in the store.
 * Allocates an ID from meta.yaml, writes the task file to backlog/,
 * updates meta.yaml, and commits both files atomically.
 *
 * Returns the short id of the new task.
 */
export async function createTask(dir: string, title: string, opts: CreateTaskOptions = {}): Promise<number> {
  return withTransaction(dir, { requireClean: true, requireValidEnums: true }, async () => {
    // Read or initialize meta.yaml
    const metaPath = join(dir, "meta.yaml");
    let nextId = 1;
    if (existsSync(metaPath)) {
      const raw = readFileSync(metaPath, "utf-8");
      const match = raw.match(/next_id:\s*(\d+)/);
      if (match) {
        nextId = parseInt(match[1], 10);
      }
    }

    const id = nextId;
    const uuid = randomUUID();
    const now = nowISO();
    const slug = slugify(title);
    const filename = `${id}-${slug}.md`;
    const taskPath = join(dir, "backlog", filename);

    const attendance = opts.attendance ?? DEFAULT_ATTENDANCE;
    const effort = opts.effort ?? DEFAULT_EFFORT;
    const deps = opts.deps ?? [];
    const body = opts.body ?? "";

    const fileContent = newTaskFile(
      dir,
      "backlog",
      filename,
      { id, uuid, title, deps, attendance, effort, created_at: now, updated_at: now },
      body,
    ).serialize();
    writeFileSync(taskPath, fileContent, "utf-8");

    // Update meta.yaml
    writeFileSync(metaPath, `next_id: ${id + 1}\n`, "utf-8");

    const taskRelPath = `backlog/${filename}`;

    // If an editor runner was provided, open the editor on the newly created
    // file BEFORE committing. This keeps the invariant of one commit per
    // invocation: the single commit covers the file's final state after the
    // editor session, including any user edits. On editor failure or
    // validation failure we roll back the on-disk writes so the working tree
    // stays clean and no abandoned id is wasted in meta.yaml.
    if (opts.runEditor) {
      const rollback = (): void => {
        try { rmSync(taskPath, { force: true }); } catch { /* ignore */ }
        try {
          if (existsSync(metaPath)) {
            // Restore the previous next_id so the abandoned id is reused.
            writeFileSync(metaPath, `next_id: ${id}\n`, "utf-8");
          }
        } catch { /* ignore */ }
      };

      const before = readFileSync(taskPath, "utf-8");

      let exit: number;
      try {
        exit = await opts.runEditor(taskPath);
      } catch (err) {
        rollback();
        throw new TasksError(
          "EDITOR_FAILED",
          `editor failed: ${err instanceof Error ? err.message : String(err)}`,
          {},
        );
      }
      if (exit !== 0) {
        rollback();
        throw new TasksError("EDITOR_FAILED", `editor exited with code ${exit}`, { exit });
      }

      const after = readFileSync(taskPath, "utf-8");
      if (after !== before) {
        // Parse and validate. Bad title -> roll back, throw.
        const parts = after.split(/^---\s*$/m);
        if (parts.length < 3) {
          rollback();
          throw new TasksError("INVALID_TITLE", "task file is missing YAML frontmatter", {});
        }
        let fm: Record<string, unknown>;
        try {
          fm = yamlParse(parts[1]) as Record<string, unknown>;
        } catch (err) {
          rollback();
          throw new TasksError(
            "INVALID_TITLE",
            `invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
            {},
          );
        }
        const titleErr = validateTitle(fm.title);
        if (titleErr !== null) {
          rollback();
          throw new TasksError("INVALID_TITLE", titleErr, {});
        }

        // Bump updated_at so timestamps reflect the editor session.
        const editNow = nowISO();
        const bumped = after.replace(/^(updated_at:\s*)(.+)$/m, `$1${editNow}`);
        writeFileSync(taskPath, bumped, "utf-8");
      }
    }

    // Stage both files and commit. Exactly one commit per invocation, whether
    // or not the editor ran (and whether or not the editor mutated the file).
    await git(["add", taskRelPath, "meta.yaml"], dir);
    await gitCommit(dir, `task: new #${id}: ${title}`);

    return id;
  });
}

// ─── Task data type (structured output) ──────────────────────────────────────

/**
 * Move a task to a different column via `git mv`, bump `updated_at`, and commit.
 * - Same column: no-op (returns without committing).
 * - Unknown id/uuid: throws TasksError with code NOT_FOUND.
 *
 * Acquires flock. Honors dirty-tree guard (caller must check outside if desired;
 * this also checks inside the lock for the definitive guard).
 */
export async function moveTask(dir: string, idOrUuid: string, targetColumn: string): Promise<void> {
  return withTransaction(dir, { requireClean: true, requireValidEnums: true }, async () => {
    // Find the task
    const task = findTask(dir, idOrUuid);
    if (!task) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }

    // Same-column no-op
    if (task.column === targetColumn) {
      return;
    }

    // Load the file and relocate it to the target column. The filename is
    // unchanged (no title edit), so commitTaskChange does a pure `git mv`
    // across columns plus the updated_at bump, in one commit.
    const tf = loadTaskFile(dir, idOrUuid);
    if (!tf) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }
    tf.column = targetColumn;
    await commitTaskChange(tf, `task: mv #${task.id} ${task.column} -> ${targetColumn}`);
  });
}

/**
 * Remove a task from the store via `git rm` and commit atomically.
 * - Unknown id/uuid: throws TasksError with code NOT_FOUND.
 * - If `force` is false and any task depends on this task: throws TasksError with code DEP_EXISTS.
 * - If `force` is true: strips the target uuid from all dependents' deps arrays,
 *   git-adds those modified files, then git-rms the target, all in ONE commit.
 *   Returns affected (modified) dependent tasks.
 *
 * Acquires flock. Honors dirty-tree guard.
 */
export async function removeTask(
  dir: string,
  idOrUuid: string,
  force: boolean = false,
): Promise<{ task: TaskData; affected: TaskData[] }> {
  return withTransaction(dir, { requireClean: true, requireValidEnums: true }, async () => {
    // Find the task
    const task = findTask(dir, idOrUuid);
    if (!task) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }

    // Find all tasks whose deps include this task's uuid
    const allTasks = findAllTasks(dir);
    const dependents = allTasks.filter((t) => t.deps.includes(task.uuid));

    if (!force && dependents.length > 0) {
      throw new TasksError(
        "DEP_EXISTS",
        `task #${task.id} is depended on by ${dependents.length} task(s); use --force to delete and strip references`,
        { dependents: dependents.map((t) => ({ id: t.id, uuid: t.uuid, title: t.title })) },
      );
    }

    // Locate the file to remove.
    const loc = findTaskFilename(dir, idOrUuid);
    if (!loc) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }

    // If force: strip the target uuid from each dependent's deps via the
    // Document API and stage each (no commit yet) so the rewrites land in the
    // same commit as the deletion below.
    if (force && dependents.length > 0) {
      for (const dep of dependents) {
        const depTf = loadTaskFileAt(dir, dep);
        if (!depTf) continue;
        const oldDeps = Array.isArray(depTf.get("deps")) ? (depTf.get("deps") as string[]) : [];
        depTf.set("deps", oldDeps.filter((u) => u !== task.uuid));
        await stageTaskFile(depTf);
      }
    }

    const relPath = `${loc.column}/${loc.filename}`;

    // git rm and commit (includes any staged dependent rewrites)
    const rmExit = await git(["rm", relPath], dir);
    if (rmExit !== 0) {
      throw new TasksError("GIT_ERROR", `git rm failed`, {});
    }

    await gitCommit(dir, `task: rm #${task.id}: ${task.title}`);

    return { task, affected: dependents };
  });
}

export interface ArchiveOptions {
  /** Single-task form: archive only this task (must be in `done/`). */
  idOrUuid?: string;
  /** Bulk form: archive done/ tasks whose `updated_at` is strictly before this instant. */
  before?: Date;
}

/**
 * Archive tasks: `git mv` them from `done/` into the `archive/` sibling
 * directory. Three forms:
 *   - no opts: archive every task currently in `done/`.
 *   - `before`: archive `done/` tasks older than the cutoff (by `updated_at`).
 *   - `idOrUuid`: archive that single task; rejects with INVALID_COLUMN if the
 *     task isn't in `done/`.
 * On a non-empty target set, produces exactly one commit covering every move
 * and the `updated_at` bumps. Empty target set is a no-op (no commit).
 *
 * Acquires flock. Honors dirty-tree guard.
 */
export async function archiveTasks(
  dir: string,
  opts: ArchiveOptions = {},
): Promise<{ archived: TaskData[] }> {
  return withTransaction(dir, { requireClean: true, requireValidEnums: true }, async () => {
    let targets: TaskData[];
    if (opts.idOrUuid) {
      const t = findTask(dir, opts.idOrUuid);
      if (!t) {
        throw new TasksError("NOT_FOUND", `task not found: ${opts.idOrUuid}`, { id: opts.idOrUuid });
      }
      if (t.column !== "done") {
        throw new TasksError(
          "INVALID_COLUMN",
          `task #${t.id} is in '${t.column}', not 'done'; only done/ tasks can be archived`,
          { column: t.column, id: t.id, uuid: t.uuid },
        );
      }
      targets = [t];
    } else {
      const doneTasks = findAllTasks(dir).filter((t) => t.column === "done");
      if (opts.before) {
        const cutoff = opts.before.getTime();
        targets = doneTasks.filter((t) => new Date(t.updated_at).getTime() < cutoff);
      } else {
        targets = doneTasks;
      }
    }

    if (targets.length === 0) {
      return { archived: [] };
    }

    mkdirSync(join(dir, ARCHIVE_DIR), { recursive: true });

    for (const task of targets) {
      const tf = loadTaskFileAt(dir, task);
      if (!tf) continue;
      tf.column = ARCHIVE_DIR;
      await stageTaskFile(tf);
    }

    const subject = targets.length === 1
      ? `task: archive #${targets[0].id}: ${targets[0].title}`
      : `task: archive ${targets.length} tasks from done`;
    await gitCommit(dir, subject);

    return { archived: targets };
  });
}

/**
 * `tasks edit --abort`: discard all pending working-tree changes in the store
 * and reset to HEAD. Does NOT acquire the flock; abort is a recovery path.
 */
export async function abortPendingEdits(dir: string): Promise<void> {
  if (!existsSync(join(dir, ".git"))) return;
  await git(["checkout", "--", "."], dir);
}

/**
 * Edit a task by round-tripping through `$EDITOR` (via the injected runner).
 *
 * Returns a discriminated outcome:
 *   - { kind: "noop" }: file unchanged after the editor exited.
 *   - { kind: "committed", titleChanged }: file changed, validated, committed.
 *
 * Errors throw TasksError with codes: NOT_FOUND, EDITOR_FAILED, INVALID_TITLE.
 * On INVALID_TITLE the bad file is left as-is on disk (edit-recovery contract;
 * see CONTEXT.md "Edit session").
 *
 * Exempt from the STORE_DIRTY guard. Acquires the flock.
 */
export async function editTask(
  dir: string,
  idOrUuid: string,
  runEditor: EditorRunner,
): Promise<{ kind: "noop" } | { kind: "committed"; titleChanged: boolean }> {
  // Enum guard rejects pre-existing bad values in other files; the edit path
  // may set new enum values, which are validated post-save below.
  return withTransaction(dir, { requireValidEnums: true }, async () => {
    const loc = findTaskFilename(dir, idOrUuid);
    if (!loc) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }
    const { column, filename } = loc;
    const filePath = join(dir, column, filename);
    const before = readFileSync(filePath, "utf-8");

    // Run editor. Any throw or non-zero exit → EDITOR_FAILED.
    let exit: number;
    try {
      exit = await runEditor(filePath);
    } catch (err) {
      throw new TasksError(
        "EDITOR_FAILED",
        `editor failed: ${err instanceof Error ? err.message : String(err)}`,
        {},
      );
    }
    if (exit !== 0) {
      throw new TasksError("EDITOR_FAILED", `editor exited with code ${exit}`, { exit });
    }

    const after = readFileSync(filePath, "utf-8");
    if (after === before) {
      return { kind: "noop" };
    }

    // Parse and validate. Bad title → leave file as-is, throw.
    const parts = after.split(/^---\s*$/m);
    if (parts.length < 3) {
      throw new TasksError("INVALID_TITLE", "task file is missing YAML frontmatter", {});
    }
    let fm: Record<string, unknown>;
    try {
      fm = yamlParse(parts[1]) as Record<string, unknown>;
    } catch (err) {
      throw new TasksError(
        "INVALID_TITLE",
        `invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        {},
      );
    }
    const titleErr = validateTitle(fm.title);
    if (titleErr !== null) {
      throw new TasksError("INVALID_TITLE", titleErr, {});
    }

    const oldFm = yamlParse((before.split(/^---\s*$/m))[1]) as Record<string, unknown>;
    const oldTitle = oldFm.title as string;
    const newTitle = fm.title as string;
    const titleChanged = oldTitle !== newTitle;

    // Validate enum fields on the edited (on-disk) content BEFORE persisting.
    // On failure we throw without writing, leaving the user's edited file on
    // disk so `tasks edit --abort` or a re-edit recovers (mirrors INVALID_TITLE).
    if (fm.attendance !== undefined && resolveAttendance(fm.attendance) === null) {
      throw new TasksError(
        "INVALID_ATTENDANCE",
        `invalid attendance: ${String(fm.attendance)}. Allowed: ${ATTENDANCE_VALUES.join(", ")}`,
        { value: fm.attendance, allowed: [...ATTENDANCE_VALUES] },
      );
    }
    if (fm.effort !== undefined && resolveEffort(fm.effort) === null) {
      throw new TasksError(
        "INVALID_EFFORT",
        `invalid effort: ${String(fm.effort)}. Allowed: ${EFFORT_VALUES.join(", ")}`,
        { value: fm.effort, allowed: [...EFFORT_VALUES] },
      );
    }

    // Validate the graph across all on-disk tasks (the editor's content is
    // already on disk). On failure, leave the bad file in place; do not commit.
    validateGraph(findAllTasks(dir));

    // Persist through the write primitive: bump updated_at, rename on a
    // slug-changing title edit, and commit exactly what's staged for this task
    // (leaving any pre-existing dirty tree alone — edit is exempt from
    // STORE_DIRTY).
    const tf = loadTaskFile(dir, idOrUuid);
    if (!tf) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }
    if (titleChanged) tf.set("title", newTitle);
    await commitTaskChange(tf, `task: edit #${oldFm.id}`);

    return { kind: "committed", titleChanged };
  });
}

/**
 * Add dependency edges from `subjectRef` to each UUID in `targetRefs`.
 *
 * - Resolves both the subject and each target by short id or UUID.
 * - Self-link is rejected with SELF_LINK before graph validation.
 * - Deduplicates: targets already present in deps are silently skipped.
 * - Runs validateGraph() after tentatively applying the new edges so
 *   UNKNOWN_UUID and CYCLE_DETECTED errors surface naturally.
 * - If no new edges would be added (all already present), still exits 0
 *   but makes no commit (no-op, matching mv same-column behavior).
 * - Otherwise: writes the updated frontmatter and commits once.
 * - Bumps updated_at on the subject task.
 *
 * Acquires flock. Honors dirty-tree guard.
 */
export async function linkTask(
  dir: string,
  subjectRef: string,
  targetRefs: string[],
): Promise<void> {
  return withTransaction(dir, { requireClean: true, requireValidEnums: true }, async () => {
    // Resolve subject
    const subject = findTask(dir, subjectRef);
    if (!subject) {
      throw new TasksError("NOT_FOUND", `task not found: ${subjectRef}`, { id: subjectRef });
    }

    // Resolve each target ref to a UUID (may be short id or UUID already)
    const allTasks = findAllTasks(dir);
    const knownByUuid = new Map(allTasks.map((t) => [t.uuid, t]));
    const knownById = new Map(allTasks.map((t) => [t.id, t]));

    const resolvedTargetUuids: string[] = [];
    for (const ref of targetRefs) {
      let targetTask: TaskData | undefined;
      if (/^\d+$/.test(ref)) {
        targetTask = knownById.get(parseInt(ref, 10));
      } else {
        targetTask = knownByUuid.get(ref);
      }

      if (!targetTask) {
        // If not resolved by short id or direct UUID lookup, throw UNKNOWN_UUID.
        // (validateGraph would catch it too, but we want a clear error here.)
        throw new TasksError(
          "UNKNOWN_UUID",
          `target not found: ${ref}`,
          { uuid: ref }
        );
      }

      // Self-link check
      if (targetTask.uuid === subject.uuid) {
        throw new TasksError(
          "SELF_LINK",
          `task cannot depend on itself: ${subject.uuid}`,
          { uuid: subject.uuid }
        );
      }

      resolvedTargetUuids.push(targetTask.uuid);
    }

    // Determine new edges (deduplicate against existing deps)
    const existingDeps = new Set(subject.deps);
    const newEdges = resolvedTargetUuids.filter((u) => !existingDeps.has(u));

    // No-op: all targets already in deps
    if (newEdges.length === 0) {
      return;
    }

    // Tentatively apply edges and validate the graph
    const updatedDeps = [...subject.deps, ...newEdges];

    // Build a temporary tasks snapshot with the updated deps for validation
    const mutatedTasks = allTasks.map((t) =>
      t.uuid === subject.uuid ? { ...t, deps: updatedDeps } : t
    );
    validateGraph(mutatedTasks);

    // Find the subject file on disk and rewrite its deps via the Document API.
    const tf = loadTaskFile(dir, subject.uuid);
    if (!tf) {
      throw new TasksError("NOT_FOUND", `task not found: ${subjectRef}`, { id: subjectRef });
    }
    tf.set("deps", updatedDeps);
    await commitTaskChange(
      tf,
      `task: link #${subject.id} depends-on ${newEdges.map((u) => u.slice(0, 8)).join(", ")}`,
    );
  });
}

/**
 * Remove dependency edges from `subjectRef` for each UUID in `targetRefs`.
 *
 * - Resolves both the subject and each target by short id or UUID.
 * - Self-unlink is rejected with SELF_LINK (mirrors link's behavior).
 * - Targets that resolve to a real task but are not currently in deps are
 *   silently ignored (idempotent).
 * - Unknown target ref (resolves to no task) throws UNKNOWN_UUID.
 * - If no edges would change (all targets absent), exits 0 with no commit.
 * - Otherwise: writes updated frontmatter, bumps updated_at, commits once.
 * - Runs validateGraph() after the mutation for consistency.
 *
 * Acquires flock. Honors dirty-tree guard.
 */
export async function unlinkTask(
  dir: string,
  subjectRef: string,
  targetRefs: string[],
): Promise<void> {
  return withTransaction(dir, { requireClean: true, requireValidEnums: true }, async () => {
    // Resolve subject
    const subject = findTask(dir, subjectRef);
    if (!subject) {
      throw new TasksError("NOT_FOUND", `task not found: ${subjectRef}`, { id: subjectRef });
    }

    // Resolve each target ref to a UUID
    const allTasks = findAllTasks(dir);
    const knownByUuid = new Map(allTasks.map((t) => [t.uuid, t]));
    const knownById = new Map(allTasks.map((t) => [t.id, t]));

    const resolvedTargetUuids: string[] = [];
    for (const ref of targetRefs) {
      let targetTask: TaskData | undefined;
      if (/^\d+$/.test(ref)) {
        targetTask = knownById.get(parseInt(ref, 10));
      } else {
        targetTask = knownByUuid.get(ref);
      }

      if (!targetTask) {
        throw new TasksError(
          "UNKNOWN_UUID",
          `target not found: ${ref}`,
          { uuid: ref }
        );
      }

      // Self-unlink check (mirrors link's SELF_LINK behavior)
      if (targetTask.uuid === subject.uuid) {
        throw new TasksError(
          "SELF_LINK",
          `task cannot unlink itself: ${subject.uuid}`,
          { uuid: subject.uuid }
        );
      }

      resolvedTargetUuids.push(targetTask.uuid);
    }

    // Compute new deps by removing the resolved targets
    const removeSet = new Set(resolvedTargetUuids);
    const updatedDeps = subject.deps.filter((u) => !removeSet.has(u));

    // No-op: deps unchanged (no target was actually in deps)
    if (updatedDeps.length === subject.deps.length) {
      return;
    }

    // Validate the graph post-mutation for consistency
    const mutatedTasks = allTasks.map((t) =>
      t.uuid === subject.uuid ? { ...t, deps: updatedDeps } : t
    );
    validateGraph(mutatedTasks);

    // Find the subject file on disk and rewrite its deps via the Document API.
    const tf = loadTaskFile(dir, subject.uuid);
    if (!tf) {
      throw new TasksError("NOT_FOUND", `task not found: ${subjectRef}`, { id: subjectRef });
    }
    tf.set("deps", updatedDeps);
    const removedUuids = subject.deps.filter((u) => removeSet.has(u));
    await commitTaskChange(
      tf,
      `task: unlink #${subject.id} remove ${removedUuids.map((u) => u.slice(0, 8)).join(", ")}`,
    );
  });
}

/**
 * Options for `setTask`. At least one field must be supplied; the caller
 * (CLI) is responsible for surfacing MISSING_FIELD when nothing is passed.
 */
export interface SetTaskOptions {
  title?: string;
  attendance?: "attended" | "unattended";
  effort?: "low" | "medium" | "high";
  /**
   * Replace the task body (the markdown after the frontmatter) from a string.
   * The only programmatic body-edit path — `editTask` is `$EDITOR`-only.
   * Written via `TaskFile.setBody`, which matches the create/parse convention
   * so the value round-trips through `parseTaskFile`/the board snapshot.
   */
  body?: string;
}

/**
 * Scalar setter for the three fields a single command can change cleanly.
 *
 * - Applies all provided fields and commits in ONE commit.
 * - `--title` recomputes the slug and performs the content update plus
 *   `git mv` in the same commit (matches `editTask` title-change semantics).
 * - `--attendance` and `--effort` enum values are pre-validated by the caller
 *   (so callers can choose human or JSON error envelopes); this function
 *   additionally re-validates to guard internal callers.
 * - `--title` is validated via the shared `validateTitle`.
 * - Bumps `updated_at`.
 *
 * Acquires flock. Honors the dirty-tree guard inside the lock.
 */
export async function setTask(
  dir: string,
  idOrUuid: string,
  opts: SetTaskOptions,
): Promise<void> {
  return withTransaction(dir, { requireClean: true, requireValidEnums: true }, async () => {
    // Validate inputs.
    if (opts.title !== undefined) {
      const err = validateTitle(opts.title);
      if (err !== null) {
        throw new TasksError("INVALID_TITLE", err, {});
      }
    }
    if (opts.attendance !== undefined && resolveAttendance(opts.attendance) === null) {
      throw new TasksError(
        "INVALID_ATTENDANCE",
        `invalid attendance: ${String(opts.attendance)}. Allowed: ${ATTENDANCE_VALUES.join(", ")}`,
        { value: opts.attendance, allowed: [...ATTENDANCE_VALUES] },
      );
    }
    if (opts.effort !== undefined && resolveEffort(opts.effort) === null) {
      throw new TasksError(
        "INVALID_EFFORT",
        `invalid effort: ${String(opts.effort)}. Allowed: ${EFFORT_VALUES.join(", ")}`,
        { value: opts.effort, allowed: [...EFFORT_VALUES] },
      );
    }

    // Find and load the task.
    const tf = loadTaskFile(dir, idOrUuid);
    if (!tf) {
      throw new TasksError("NOT_FOUND", `task not found: ${idOrUuid}`, { id: idOrUuid });
    }
    const id = tf.id;

    // Apply provided fields. Setting the title triggers the slug rename inside
    // commitTaskChange; the Document API handles quoting (no JSON.stringify hack).
    const changed: string[] = [];
    if (opts.title !== undefined) {
      tf.set("title", opts.title);
      changed.push("title");
    }
    if (opts.attendance !== undefined) {
      tf.set("attendance", opts.attendance);
      changed.push("attendance");
    }
    if (opts.effort !== undefined) {
      tf.set("effort", opts.effort);
      changed.push("effort");
    }
    if (opts.body !== undefined) {
      tf.setBody(opts.body);
      changed.push("body");
    }

    await commitTaskChange(tf, `task: set #${id} ${changed.join(", ")}`);
  });
}

/**
 * Revert the most recent commit in the store with `git revert --no-edit HEAD`.
 *
 * Refuses with NOTHING_TO_UNDO when HEAD is the root (auto-init seed) commit,
 * detected by comparing `git rev-parse HEAD` against
 * `git rev-list --max-parents=0 HEAD`.
 *
 * Returns the SHA of the revert commit (now HEAD) on success.
 */
export async function undoStore(dir: string): Promise<{ revertSha: string; revertedSha: string }> {
  return withTransaction(dir, { requireClean: true }, async () => {
    const head = await gitCapture(dir, ["rev-parse", "HEAD"]);
    const root = await gitCapture(dir, ["rev-list", "--max-parents=0", "HEAD"]);

    if (head === root) {
      throw new TasksError(
        "NOTHING_TO_UNDO",
        "nothing to undo: store has no mutations beyond the initial commit",
        {}
      );
    }

    // revert writes a commit, so it needs the same identity fallback as gitCommit.
    const ident = await identityArgs(dir);
    const proc = Bun.spawn(["git", "-C", dir, ...ident, "revert", "--no-edit", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (code !== 0) {
      // Best-effort cleanup so the working tree is not left mid-revert.
      const abort = Bun.spawn(["git", "-C", dir, "revert", "--abort"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await abort.exited;
      throw new TasksError(
        "UNDO_FAILED",
        `git revert failed: ${stderr.trim() || stdout.trim()}`,
        {}
      );
    }

    const revertSha = await gitCapture(dir, ["rev-parse", "HEAD"]);
    return { revertSha, revertedSha: head };
  });
}
