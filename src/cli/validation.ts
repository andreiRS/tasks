import { emit, type OutputContext } from "./output.ts";

/**
 * Validate a task title. Returns null on success, or an error message string.
 * Constraints: non-empty, single line (no newline characters), max 200 characters.
 */
export function validateTitle(title: string): string | null {
  if (!title || title.trim() === "") {
    return "title is required";
  }
  if (/[\n\r]/.test(title)) {
    return "title must be a single line (no newline characters)";
  }
  if (title.length > 200) {
    return `title must be 200 characters or fewer (got ${title.length})`;
  }
  return null;
}

/**
 * Parse a duration string of the form `<N>d` (e.g. "7d", "30d", "0d").
 * Returns the number of days as a non-negative integer, or null if invalid.
 */
export function parseSinceDays(value: string): number | null {
  const match = /^(\d+)d$/.exec(value);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Validate that `value` is one of `allowed`. On failure, emit an error and exit(1).
 * Returns void on success.
 */
export function validateEnumOrExit(
  flagName: string,
  value: string,
  allowed: readonly string[],
  ctx: OutputContext,
  code: string
): void {
  if (allowed.includes(value)) return;
  const msg = `invalid ${flagName} value: ${value}. Allowed: ${allowed.join(", ")}`;
  emit({ ok: false, code, message: msg, details: { value, allowed: [...allowed] } }, ctx);
}
