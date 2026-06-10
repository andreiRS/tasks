// A single post-it card face. Read-only for #18; #19 makes it draggable, #21
// opens a modal on click. Keep the visual contract here (seeded paper + tilt,
// short-id pill, handwritten title, body preview, effort dot, blocked badge,
// attendance marker, "updated Xm ago").

import type { BoardTask } from "./types";
import { seededStyle } from "./seed";
import { EFFORT_DOT } from "./effort";
import { timeAgo } from "./time";

export function Card({ task }: { task: BoardTask }) {
  const { bg, edge, tilt } = seededStyle(task.id);
  const effort = EFFORT_DOT[task.effort];
  const isBlocked = task.blockedBy.length > 0;
  const isAgent = task.attendance === "unattended";

  return (
    <article
      className="relative rounded-[3px] px-3.5 pt-3 pb-2.5 text-slate-800 shadow-[2px_3px_6px_rgba(0,0,0,0.18)] transition-transform duration-150 hover:-translate-y-0.5 hover:rotate-0"
      style={{
        backgroundColor: bg,
        // The darker edge sells the layered-paper look.
        borderBottom: `2px solid ${edge}`,
        transform: `rotate(${tilt}deg)`,
      }}
    >
      {/* Effort dot — top-right corner */}
      <span
        className="absolute right-2 top-2 size-2.5 rounded-full ring-1 ring-black/10"
        style={{ backgroundColor: effort.color }}
        title={effort.label}
        aria-label={effort.label}
      />

      {/* Header: short-id pill + attendance marker */}
      <div className="mb-1.5 flex items-center gap-1.5 pr-4">
        <span className="inline-flex items-center rounded-full bg-black/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-tight text-slate-700">
          #{task.id}
        </span>
        <span
          className="text-[13px] leading-none"
          title={isAgent ? "agent (unattended)" : "human (attended)"}
          aria-label={isAgent ? "agent task" : "attended task"}
        >
          {isAgent ? "🤖" : "🙂"}
        </span>
      </div>

      {/* Handwritten title */}
      <h3 className="font-script text-lg leading-snug break-words">
        {task.title}
      </h3>

      {/* ~2-line body preview */}
      {task.body.trim() && (
        <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-slate-600/90">
          {task.body}
        </p>
      )}

      {/* blocked-by badge */}
      {isBlocked && (
        <div className="mt-2 inline-flex items-center gap-1 rounded-sm bg-red-600/90 px-1.5 py-0.5 text-[11px] font-semibold text-white shadow-sm">
          <span aria-hidden>⛔</span>
          blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}
        </div>
      )}

      {/* footer: updated age */}
      <div className="mt-2 text-[11px] italic text-slate-500">
        updated {timeAgo(task.updated_at)}
      </div>
    </article>
  );
}
