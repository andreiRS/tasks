// A single post-it card face. #19 makes it draggable (dnd-kit useDraggable) and
// applies the delay-gated pending look while its move is in flight. #21 will
// open a modal on click. Keep the visual contract here (seeded paper + tilt,
// short-id pill, handwritten title, body preview, effort dot, blocked badge,
// attendance marker, "updated Xm ago").

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { BoardTask } from "./types";
import { useBoardStore } from "../store";
import { seededStyle } from "./seed";
import { EffortBadge } from "./effort";
import { timeAgo } from "./time";

export function Card({ task }: { task: BoardTask }) {
  // A create placeholder has the sentinel id -1 (no short id assigned yet); it
  // renders a muted "#…" pill instead of a real id and isn't draggable until the
  // snapshot replaces it with the real card.
  const isPlaceholder = task.id < 0;
  const { bg, edge, tilt } = seededStyle(isPlaceholder ? 0 : task.id);
  const isBlocked = task.blockedBy.length > 0;
  const isAgent = task.attendance === "unattended";

  // Pending look only once the 200ms delay gate has fired (slow writes only).
  // A move tracks under `pending` (by uuid); a create under `pendingCreates`
  // (keyed by its temp key, which is the placeholder's uuid); an edit under
  // `pendingEdits` (by uuid).
  const showPending = useBoardStore(
    (s) =>
      s.pending[task.uuid]?.showPending ??
      s.pendingEdits[task.uuid]?.showPending ??
      s.pendingCreates[task.uuid]?.showPending ??
      false,
  );
  const openCard = useBoardStore((s) => s.openCard);
  const archiveTask = useBoardStore((s) => s.archiveTask);

  // Done cards carry an Archive control to clear them off the board (the done
  // column fills up). Hidden on placeholders (no real card yet).
  const isDone = task.column === "done" && !isPlaceholder;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.uuid,
    // Carry the full task so onDragEnd can dispatch the move without a lookup.
    data: { task },
    // A placeholder can't be moved until the server assigns it a real id.
    disabled: isPlaceholder,
  });

  return (
    <article
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      // A plain click (under the 8px PointerSensor activation distance set in
      // App.tsx) opens the drawer; a real drag passes the threshold and moves
      // instead, so onClick never fires for it. Placeholders have no real card
      // to show yet.
      onClick={() => {
        if (!isPlaceholder) openCard(task.uuid);
      }}
      // No transition on the card being dragged: dnd-kit rewrites `transform`
      // on every pointermove, and a transition-transform would animate each of
      // those over 150ms, so the card chases the pointer a frame behind (laggy
      // drag). Keep the transition only at rest for the hover lift.
      className={`relative touch-none rounded-[3px] px-3.5 pt-3 pb-2.5 text-slate-800 shadow-[2px_3px_6px_rgba(0,0,0,0.18)] hover:-translate-y-0.5 hover:rotate-0 ${
        isDragging ? "" : "transition-transform duration-150"
      } ${
        isPlaceholder ? "cursor-default" : "cursor-grab active:cursor-grabbing"
      }`}
      style={{
        backgroundColor: bg,
        // The darker edge sells the layered-paper look.
        borderBottom: `2px solid ${edge}`,
        // Live drag translate composes with the resting tilt.
        transform: transform
          ? `${CSS.Translate.toString(transform)} rotate(${tilt}deg)`
          : `rotate(${tilt}deg)`,
        // Pending = subtle fade only. No border/size change so the card never jumps.
        opacity: showPending ? 0.6 : 1,
        zIndex: isDragging ? 50 : undefined,
        // Stable per-card name so the View Transitions API can morph this card
        // from its old lane slot to the new one when an external move arrives
        // (store.applySnapshot wraps such commits in a transition). uuid is
        // unique; the `card-` prefix guarantees a valid CSS custom-ident.
        viewTransitionName: isPlaceholder ? undefined : `card-${task.uuid}`,
      }}
    >
      {/* Effort t-shirt size (S/M/L) — a colored taped tab straddling the top edge */}
      <EffortBadge effort={task.effort} variant="tab" className="absolute -top-0 right-4 z-10" />

      {/* Pending clock badge — tiny bottom-right corner element, no layout shift */}
      {showPending && (
        <span
          className="pointer-events-none absolute bottom-1.5 right-1.5 text-[13px] leading-none text-slate-500/80"
          title="saving…"
          aria-label="saving"
        >
          ◷
        </span>
      )}

      {/* Header: short-id pill (attendance marker now lives in the footer's
          bottom-right "assignee" slot) */}
      <div className="mb-1.5 flex items-center gap-1.5 pr-4">
        {isPlaceholder ? (
          <span
            className="inline-flex items-center rounded-full bg-black/5 px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-tight text-slate-400"
            title="saving — id assigned on save"
            aria-label="pending id"
          >
            #…
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-black/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-tight text-slate-700">
            #{task.id}
          </span>
        )}

        {/* Archive — done cards only. Sits right after the id pill. One click
            archives the task (POST /api/tasks/:id/archive, one commit) and clears
            it off the board. stopPropagation keeps the click from starting a drag
            or opening the drawer. */}
        {isDone && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              void archiveTask(task);
            }}
            title="Archive (clear off the board)"
            aria-label={`Archive task #${task.id}`}
            className="inline-flex items-center rounded-[2px] bg-black/5 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-black/15 transition hover:bg-slate-700 hover:text-white"
          >
            Archive
          </button>
        )}
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

      {/* footer: a dashed rule, then updated age (left) + the attendance marker
          in the bottom-right "assignee" slot (Jira-style): a small circle with
          H (human/attended) or A (agent/unattended). Hidden while the pending ◷
          badge owns that corner, so the two never overlap. */}
      <div className="mt-2 flex items-center justify-between border-t border-dashed border-black/15 pt-2">
        <span className="text-[11px] italic text-slate-500">
          updated {timeAgo(task.updated_at)}
        </span>
        {!showPending && (
          <span
            className={`flex size-6 items-center justify-center rounded-full text-[10px] font-semibold ring-1 ${
              isAgent
                ? "bg-violet-100/70 text-violet-700 ring-violet-400/50"
                : "bg-slate-200/70 text-slate-600 ring-black/15"
            }`}
            title={isAgent ? "agent (unattended)" : "human (attended)"}
            aria-label={isAgent ? "agent task" : "attended task"}
          >
            {isAgent ? "A" : "H"}
          </span>
        )}
      </div>
    </article>
  );
}
