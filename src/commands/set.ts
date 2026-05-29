import { findTask, setTask, type TaskData } from "../store.ts";
import { emit, failFromError, outputContext } from "../cli/output.ts";
import { mutatingPreamble } from "../cli/preflight.ts";
import { validateEnumOrExit, validateTitle } from "../cli/validation.ts";

const VALID_ATTENDANCE = ["attended", "unattended"] as const;
const VALID_EFFORT = ["low", "medium", "high"] as const;

export async function run(rest: string[]): Promise<void> {
  const ctx = outputContext(rest);

  const posArgs = rest.filter((a) => !a.startsWith("--"));
  const subjectRef = posArgs[0] ?? "";

  let titleValue: string | undefined;
  let titlePresent = false;
  let attendanceValue: string | undefined;
  let effortValue: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--title" && i + 1 < rest.length) {
      titleValue = rest[i + 1];
      titlePresent = true;
      i++;
    } else if (rest[i] === "--attendance" && i + 1 < rest.length) {
      attendanceValue = rest[i + 1];
      i++;
    } else if (rest[i] === "--effort" && i + 1 < rest.length) {
      effortValue = rest[i + 1];
      i++;
    }
  }

  if (!subjectRef) {
    const msg = "usage: tasks set <id|uuid> [--title <title>] [--attendance <attended|unattended>] [--effort <low|medium|high>]";
    emit({ ok: false, code: "MISSING_FIELD", message: msg }, ctx);
  }

  if (!titlePresent && attendanceValue === undefined && effortValue === undefined) {
    const msg = "tasks set requires at least one of --title, --attendance, --effort";
    emit({ ok: false, code: "MISSING_FIELD", message: msg }, ctx);
  }

  if (attendanceValue !== undefined) {
    validateEnumOrExit("--attendance", attendanceValue, VALID_ATTENDANCE, ctx, "INVALID_ATTENDANCE");
  }
  if (effortValue !== undefined) {
    validateEnumOrExit("--effort", effortValue, VALID_EFFORT, ctx, "INVALID_EFFORT");
  }
  if (titlePresent) {
    const err = validateTitle(titleValue ?? "");
    if (err !== null) {
      emit({ ok: false, code: "INVALID_TITLE", message: err }, ctx);
    }
  }

  const dir = await mutatingPreamble(ctx);

  let setTaskBefore: TaskData | null = null;
  if (ctx.json) {
    setTaskBefore = findTask(dir, subjectRef);
  }

  try {
    await setTask(dir, subjectRef, {
      title: titlePresent ? titleValue : undefined,
      attendance: attendanceValue as "attended" | "unattended" | undefined,
      effort: effortValue as "low" | "medium" | "high" | undefined,
    });
  } catch (err) {
    emit(failFromError(err), ctx);
  }

  if (ctx.json && setTaskBefore) {
    const changed: Record<string, unknown> = {};
    if (titlePresent && titleValue !== setTaskBefore.title) {
      changed.title = titleValue;
    }
    if (attendanceValue !== undefined && attendanceValue !== setTaskBefore.attendance) {
      changed.attendance = attendanceValue;
    }
    if (effortValue !== undefined && effortValue !== setTaskBefore.effort) {
      changed.effort = effortValue;
    }
    process.stdout.write(JSON.stringify({ ok: true, id: setTaskBefore.id, uuid: setTaskBefore.uuid, changed }) + "\n");
  }
}
