// `tasks serve` board UI. Read-only six-lane board over GET /api/board (#18),
// now with drag-to-move (#19): the board is wrapped in a DndContext, a drop
// dispatches an optimistic move + reconcile, and a failed move raises a toast.
// SSE live updates (#20), the create modal (#21) and the detail drawer (#22)
// build on this.

import { useEffect } from "react";
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
import { timeAgo } from "./board/time";

export function App() {
  const board = useBoardStore((s) => s.board);
  const status = useBoardStore((s) => s.status);
  const error = useBoardStore((s) => s.error);
  const load = useBoardStore((s) => s.load);
  const move = useBoardStore((s) => s.move);

  useEffect(() => {
    void load();
  }, [load]);

  // Pointer for mouse/touch/pen; Keyboard for accessible drag (space/enter to
  // grab, arrows to move, space/enter to drop) — see dnd-kit v6 sensors.
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

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
          <h1 className="font-script text-3xl text-slate-800">board</h1>
          {board?.head && (
            <span className="text-xs text-slate-400">
              board {timeAgo(board.head.committed_at)}
            </span>
          )}
        </header>

        {status === "loading" && (
          <p className="px-6 pt-6 text-sm text-slate-400">loading board…</p>
        )}

        {status === "error" && (
          <p className="px-6 pt-6 text-sm text-red-600">
            could not reach /api/board{error ? ` (${error})` : ""}
          </p>
        )}

        {status === "ready" && board && (
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <Board board={board} />
          </DndContext>
        )}
      </main>

      <Toast />
    </div>
  );
}
