// Effort → corner dot color. Green (low) → amber (medium) → red (high), a
// familiar low/medium/high ramp.

import type { Effort } from "./types";

export const EFFORT_DOT: Record<Effort, { color: string; label: string }> = {
  low: { color: "#22c55e", label: "low effort" },
  medium: { color: "#f59e0b", label: "medium effort" },
  high: { color: "#ef4444", label: "high effort" },
};
