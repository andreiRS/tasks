// The six-lane board. Renders lanes in the server-given `columns` order with
// horizontal scroll. Read-only for #18.

import type { Board as BoardSnapshot } from "./types";
import { Lane } from "./Lane";

export function Board({ board }: { board: BoardSnapshot }) {
  return (
    <div className="flex min-h-0 flex-1 gap-6 overflow-auto px-6 pb-8 pt-2">
      {board.columns.map((column) => (
        <Lane key={column} column={column} tasks={board.lanes[column] ?? []} />
      ))}
    </div>
  );
}
