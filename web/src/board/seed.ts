// Deterministic per-task visuals, seeded from the task id.
//
// The same id always yields the same paper color + tilt, stable across reloads
// (no randomness, no time/order input). A small integer hash of the id selects
// a palette slot and a tilt bucket.

/** A warm-paper palette for sticky notes (background + a slightly darker edge). */
export const PAPER_COLORS: ReadonlyArray<{ bg: string; edge: string }> = [
  { bg: "#fff7c0", edge: "#f2e58c" }, // butter yellow
  { bg: "#ffe0b3", edge: "#f5cd8f" }, // peach
  { bg: "#d8f5c8", edge: "#bfe7a8" }, // mint
  { bg: "#cfe9ff", edge: "#aed6f5" }, // sky
  { bg: "#ffd6e0", edge: "#f5b8c7" }, // rose
  { bg: "#e6d8ff", edge: "#cfbaf0" }, // lilac
  { bg: "#fef0d0", edge: "#f0dcae" }, // cream
];

/** Tilt buckets in degrees — a few degrees either side, never zero so every card looks placed by hand. */
const TILTS: readonly number[] = [-2.5, -1.5, -1, 1, 1.5, 2.5];

/**
 * Stable 32-bit-ish hash of a number id. Pure function of the id, so the same
 * id always hashes the same. (FNV-1a over the decimal digits of the id.)
 */
export function hashId(id: number): number {
  const s = String(id);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Seeded {
  bg: string;
  edge: string;
  /** rotation in degrees */
  tilt: number;
}

/** Derive paper color + tilt for a task, deterministically from its id. */
export function seededStyle(id: number): Seeded {
  const h = hashId(id);
  const color = PAPER_COLORS[h % PAPER_COLORS.length];
  // Use a different slice of the hash for tilt so color and tilt don't correlate.
  const tilt = TILTS[Math.floor(h / PAPER_COLORS.length) % TILTS.length];
  return { bg: color.bg, edge: color.edge, tilt };
}
