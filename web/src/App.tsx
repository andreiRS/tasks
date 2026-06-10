// `tasks serve` board UI (#18) — read-only six-lane board over GET /api/board.
// Drag (#19), SSE live updates (#20), the create modal (#21) and the detail
// drawer (#22) build on this; they are deliberately NOT implemented here.

import { useEffect } from "react";
import { useBoardStore } from "./store";
import { Rail } from "./board/Rail";
import { Board } from "./board/Board";
import { timeAgo } from "./board/time";

export function App() {
  const board = useBoardStore((s) => s.board);
  const status = useBoardStore((s) => s.status);
  const error = useBoardStore((s) => s.error);
  const load = useBoardStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

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

        {status === "ready" && board && <Board board={board} />}
      </main>
    </div>
  );
}
