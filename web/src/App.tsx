// `tasks serve` board UI. Read-only six-lane board over GET /api/board (#18),
// now with drag-to-move (#19): the board is wrapped in a DndContext, a drop
// dispatches an optimistic move + reconcile, and a failed move raises a toast.
// SSE live updates (#20), the create modal (#21) and the detail drawer (#22)
// build on this.

import { useEffect, useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useBoardStore } from "./store";
import { Rail } from "./board/Rail";
import { Board } from "./board/Board";
import { Toast } from "./board/Toast";
import { NewTaskModal } from "./board/NewTaskModal";
import { CardDrawer } from "./board/CardDrawer";
import { timeAgo } from "./board/time";

export function App() {
  const board = useBoardStore((s) => s.board);
  const status = useBoardStore((s) => s.status);
  const error = useBoardStore((s) => s.error);
  const connection = useBoardStore((s) => s.connection);
  const subscribe = useBoardStore((s) => s.subscribe);
  const load = useBoardStore((s) => s.load);
  const move = useBoardStore((s) => s.move);
  const [showNewTask, setShowNewTask] = useState(false);

  // Live board via SSE (#20). The stream's connect frame renders the initial
  // board and every committed mutation pushes a fresh full snapshot, so the
  // board stays current with no refetch. subscribe() runs its own self-healing
  // reconnect loop (native auto-retry stalls), surfacing a subtle "reconnecting"
  // hint when an established stream drops. The effect's cleanup closes the live
  // EventSource and clears the pending reconnect timer, which makes StrictMode's
  // double-invoke safe (the first run is fully torn down before the second sets
  // up) and never leaks or duplicates a connection or timer.
  useEffect(() => subscribe(), [subscribe]);

  // Pointer for mouse/touch/pen; Keyboard for accessible drag (space/enter to
  // grab, arrows to move, space/enter to drop) — see dnd-kit v6 sensors. The
  // 8px activation distance means a plain click (under threshold) is NOT a drag,
  // so a card's onClick can open the drawer (#22) while a real drag still moves.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return; // dropped outside any lane
    const toColumn = String(over.id);
    const task = active.data.current?.task;
    if (!task) return;
    void move(task, toColumn);
  }

  return (
    <div className="flex min-h-screen bg-[#f4f1ea] text-slate-800">
      <Rail />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-baseline justify-between px-6 pt-5">
          <div className="flex items-baseline gap-3">
            <h1 className="font-script text-3xl text-slate-800">Tasks Board</h1>
            {board?.head && (
              <span className="text-xs text-slate-400">
                updated {timeAgo(board.head.committed_at)}
              </span>
            )}
          </div>
          {status === "ready" && (
            <button
              type="button"
              onClick={() => setShowNewTask(true)}
              className="self-center rounded-md bg-slate-800 px-3 py-1.5 text-sm font-semibold text-amber-100 shadow-sm hover:bg-slate-700"
            >
              + new task
            </button>
          )}
        </header>

        {/* Subtle, non-destructive hint: an established stream dropped and is
            reconnecting. Floated top-center (fixed, out of header flow) so it
            never shifts the header layout — e.g. the "+ new task" button. The
            last board stays visible (we don't flip to the hard error screen);
            an initial-connect failure uses the error UI below instead. */}
        {status === "ready" && connection === "reconnecting" && (
          <span
            role="status"
            className="fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-700 shadow-md ring-1 ring-amber-200/70"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            live connection lost — reconnecting…
          </span>
        )}

        {status === "loading" && (
          <p className="px-6 pt-6 text-sm text-slate-400">loading board…</p>
        )}

        {status === "error" && (
          <p className="px-6 pt-6 text-sm text-red-600">
            could not reach the board{error ? ` (${error})` : ""}{" "}
            <button
              type="button"
              onClick={() => void load()}
              className="underline underline-offset-2 hover:text-red-700"
            >
              retry
            </button>
          </p>
        )}

        {status === "ready" && board && (
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <Board board={board} />
          </DndContext>
        )}
      </main>

      <NewTaskModal open={showNewTask} onClose={() => setShowNewTask(false)} />
      <CardDrawer />
      <Toast />
    </div>
  );
}
