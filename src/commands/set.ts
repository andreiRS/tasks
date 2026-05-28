import { findTask, setTask, type TaskData } from "../store.ts";
import { handleTasksError, writeJsonError, writePlainError } from "../cli/errors.ts";
import { mutatingPreamble } from "../cli/preflight.ts";
import { validateEnumOrExit, validateTitle } from "../cli/validation.ts";

const VALID_ATTENDANCE = ["attended", "unattended"] as const;
const VALID_EFFORT = ["low", "medium", "high"] as const;

export async function run(rest: string[]): Promise<void> {
  const jsonFlag = rest.includes("--json");

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
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", msg, {});
    } else {
      writePlainError(`MISSING_FIELD: ${msg}`);
    }
    process.exit(1);
  }

  if (!titlePresent && attendanceValue === undefined && effortValue === undefined) {
    const msg = "tasks set requires at least one of --title, --attendance, --effort";
    if (jsonFlag) {
      writeJsonError("MISSING_FIELD", msg, {});
    } else {
      writePlainError(`MISSING_FIELD: ${msg}`);
    }
    process.exit(1);
  }

  if (attendanceValue !== undefined) {
    validateEnumOrExit("--attendance", attendanceValue, VALID_ATTENDANCE, jsonFlag, "INVALID_ATTENDANCE");
  }
  if (effortValue !== undefined) {
    validateEnumOrExit("--effort", effortValue, VALID_EFFORT, jsonFlag, "INVALID_EFFORT");
  }
  if (titlePresent) {
    const err = validateTitle(titleValue ?? "");
    if (err !== null) {
      if (jsonFlag) {
        writeJsonError("INVALID_TITLE", err, {});
      } else {
        writePlainError(`INVALID_TITLE: ${err}`);
      }
      process.exit(1);
    }
  }

  const dir = await mutatingPreamble(jsonFlag);

  let setTaskBefore: TaskData | null = null;
  if (jsonFlag) {
    setTaskBefore = findTask(dir, subjectRef);
  }

  try {
    await setTask(dir, subjectRef, {
      title: titlePresent ? titleValue : undefined,
      attendance: attendanceValue as "attended" | "unattended" | undefined,
      effort: effortValue as "low" | "medium" | "high" | undefined,
    });
  } catch (err) {
    handleTasksError(err, jsonFlag);
  }

  if (jsonFlag && setTaskBefore) {
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
