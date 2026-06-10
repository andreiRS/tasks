// One board column. Header (name + count), a vertical stack of cards, and a
// quiet dashed drop-zone when empty. #19 turns this into a droppable target.

import type { BoardTask } from "./types";
import { Card } from "./Card";

/** Human-friendly lane title from the canonical column key. */
function laneTitle(column: string): string {
  return column.charAt(0).toUpperCase() + column.slice(1);
}

export function Lane({ column, tasks }: { column: string; tasks: BoardTask[] }) {
  return (
    <section className="flex w-72 shrink-0 flex-col">
      <header className="mb-3 flex items-baseline justify-between px-1">
        <h2 className="font-script text-xl text-slate-700">{laneTitle(column)}</h2>
        <span className="rounded-full bg-slate-200 px-2 py-0.5 font-mono text-xs font-semibold text-slate-500">
          {tasks.length}
        </span>
      </header>

      <div className="flex flex-1 flex-col gap-4">
        {tasks.length === 0 ? (
          <div className="mt-1 flex min-h-28 items-center justify-center rounded-md border-2 border-dashed border-slate-300/80 px-3 text-center font-script text-base text-slate-400">
            nothing here yet
          </div>
        ) : (
          tasks.map((t) => <Card key={t.uuid} task={t} />)
        )}
      </div>
    </section>
  );
}
