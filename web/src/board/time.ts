// "updated Xm ago" formatting from an ISO-8601 timestamp.

/**
 * Compact relative age: "just now", "5m ago", "3h ago", "2d ago".
 * `iso` is the task's updated_at; `now` is injectable for determinism.
 */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
