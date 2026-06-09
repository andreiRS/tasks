/**
 * The single seam for reading wall-clock time. Every "now" in the app routes
 * through here so tests can pin a deterministic clock via the `TASKS_NOW`
 * environment variable (an ISO 8601 string). When unset or unparseable it
 * falls back to the real system clock.
 *
 * Mirrors the env-var config pattern used for `TASKS_HOME` (paths.ts) and
 * `NO_COLOR`/`FORCE_COLOR` (cli/color.ts): a direct `process.env` read with a
 * sensible fallback.
 */

/** Current time in epoch milliseconds, honoring `TASKS_NOW`. */
export function nowMs(): number {
  const override = process.env.TASKS_NOW;
  if (override) {
    const parsed = Date.parse(override);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

/** Current UTC timestamp in ISO 8601 (the canonical created_at/updated_at form), honoring `TASKS_NOW`. */
export function nowISO(): string {
  return new Date(nowMs()).toISOString();
}
