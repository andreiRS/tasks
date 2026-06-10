// One board column. Header (name + count), a vertical stack of cards, and a
// quiet dashed drop-zone when empty. #19 makes the whole lane (incl. the empty
// drop-zone) a droppable target keyed by its column.

import { useDroppable } from "@dnd-kit/core";
import type { BoardTask } from "./types";
import { Card } from "./Card";

/** Human-friendly lane title from the canonical column key. */
function laneTitle(column: string): string {
  return column.charAt(0).toUpperCase() + column.slice(1);
}

export function Lane({ column, tasks }: { column: string; tasks: BoardTask[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: column });

  return (
    <section className="flex w-72 shrink-0 flex-col">
      <header className="sticky top-0 z-10 mb-3 flex items-baseline justify-between bg-[var(--paper)] px-1 pb-2 pt-1">
        <h2 className="font-script text-xl text-slate-700 dark:text-slate-300">{laneTitle(column)}</h2>
        <span className="rounded-full bg-slate-200 px-2 py-0.5 font-mono text-xs font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-300">
          {tasks.length}
        </span>
      </header>

      {/* The whole lane body is the drop target; a subtle wash marks hover. */}
      <div
        ref={setNodeRef}
        className={`flex flex-1 flex-col gap-4 rounded-md transition-colors ${
          isOver ? "bg-slate-900/[0.04] dark:bg-white/[0.05]" : ""
        }`}
      >
        {tasks.length === 0 ? (
          <div className="mt-1 flex min-h-28 items-center justify-center rounded-md border-2 border-dashed border-slate-300/80 px-3 text-center font-script text-base text-slate-400 dark:border-slate-600/70 dark:text-slate-500">
            nothing here yet
          </div>
        ) : (
          tasks.map((t) => <Card key={t.uuid} task={t} />)
        )}
      </div>
    </section>
  );
}
