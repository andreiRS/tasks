// Deterministic per-task visuals, seeded from the task id.
//
// The same id always yields the same paper color slot + tilt, stable across
// reloads (no randomness, no time/order input). A small integer hash of the id
// selects a palette slot and a tilt bucket.
//
// The actual paper COLORS live in index.css, keyed by `[data-paper="<slot>"]`,
// so light and dark sticky-note tones are a pure CSS swap (the card reads
// `var(--card-bg)` / `var(--card-edge)`). This module only decides which slot
// and tilt a task gets — it carries no hex.

/** Number of paper-color slots (must match the `[data-paper=N]` rules in CSS). */
export const PAPER_SLOTS = 7;

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
  /** Paper-color slot index in [0, PAPER_SLOTS). Drives the `data-paper` attr. */
  slot: number;
  /** rotation in degrees */
  tilt: number;
}

/** Derive paper-color slot + tilt for a task, deterministically from its id. */
export function seededStyle(id: number): Seeded {
  const h = hashId(id);
  const slot = h % PAPER_SLOTS;
  // Use a different slice of the hash for tilt so color and tilt don't correlate.
  const tilt = TILTS[Math.floor(h / PAPER_SLOTS) % TILTS.length];
  return { slot, tilt };
}
