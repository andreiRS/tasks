/**
 * A structured error thrown by the tasks CLI store layer.
 * `code` is a stable machine-readable enum value (e.g. "FLOCK_MISSING").
 * `details` carries any extra context the caller wants to surface.
 */
export class TasksError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "TasksError";
  }
}
