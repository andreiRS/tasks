/**
 * Return the value following a single-value flag, or undefined.
 * For repeatable flags use `collectRepeated`.
 */
export function getFlagValue(rest: string[], flag: string): string | undefined {
  const idx = rest.indexOf(flag);
  if (idx === -1 || idx + 1 >= rest.length) return undefined;
  return rest[idx + 1];
}

/**
 * Collect all values for a repeatable `--flag <value>` pair, in order.
 */
export function collectRepeated(rest: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === flag && i + 1 < rest.length) {
      out.push(rest[i + 1]);
      i++;
    }
  }
  return out;
}
