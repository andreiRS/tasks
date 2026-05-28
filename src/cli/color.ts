/**
 * Decide whether to emit ANSI color. Precedence:
 *   1. `--no-color` (`noColorFlag` true) always wins (force off).
 *   2. `NO_COLOR` env var set to any non-empty value wins (force off).
 *   3. `FORCE_COLOR=1` forces on even when stdout is not a TTY.
 *   4. Otherwise: color iff stdout is a TTY.
 */
export function shouldColor(noColorFlag: boolean): boolean {
  if (noColorFlag) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR === "1") return true;
  return Boolean(process.stdout.isTTY);
}
