// Effort → t-shirt size badge. low → S, medium → M, high → L, on a familiar
// green → amber → red ramp so the size still reads as a low/medium/high cue at
// a glance. EffortBadge is the single rendering used by the card corner, the
// drawer meta row, and both effort pickers.

import type { Effort } from "./types";

export const EFFORT: Record<Effort, { color: string; size: string; label: string }> = {
  low: { color: "#22c55e", size: "S", label: "low effort (S)" },
  medium: { color: "#f59e0b", size: "M", label: "medium effort (M)" },
  high: { color: "#ef4444", size: "L", label: "high effort (L)" },
};

/**
 * The t-shirt size (S/M/L) marker. Two looks:
 *  - "square" (default): a small solid colored chip, for the drawer meta row and
 *    the effort pickers where it sits inline next to a text label.
 *  - "tab": a translucent, slightly tilted paper tab with a soft shadow and a
 *    colored letter, meant to be positioned straddling the card's top edge so it
 *    reads like a piece of tape stuck on the sticky note.
 * `className` is merged so callers can position it (e.g. the card's top edge).
 */
export function EffortBadge({
  effort,
  className = "",
  variant = "square",
}: {
  effort: Effort;
  className?: string;
  variant?: "square" | "tab";
}) {
  const e = EFFORT[effort];
  if (variant === "tab") {
    return (
      <span
        className={`flex h-5 w-8 rotate-3 items-center justify-center rounded-[2px] text-[11px] font-bold text-white shadow-[1px_2px_4px_rgba(0,0,0,0.28)] ring-1 ring-black/10 ${className}`}
        style={{ backgroundColor: e.color }}
        title={e.label}
        aria-label={e.label}
      >
        {e.size}
      </span>
    );
  }
  return (
    <span
      className={`flex size-5 items-center justify-center rounded-[4px] text-[10px] font-bold text-white ring-1 ring-black/10 ${className}`}
      style={{ backgroundColor: e.color }}
      title={e.label}
      aria-label={e.label}
    >
      {e.size}
    </span>
  );
}
