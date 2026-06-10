// Board snapshot store (Zustand). Intentionally tiny for the read-only slice
// (#18): it holds the latest `/api/board` snapshot + load status. Later slices
// extend it — #19 optimistic moves, #20 replaces the whole snapshot on each SSE
// message — but those actions are NOT added here yet.

import { create } from "zustand";
import type { Board } from "./board/types";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

interface BoardState {
  board: Board | null;
  status: LoadStatus;
  error: string | null;
  /** Fetch the current snapshot from the API and replace store state. */
  load: () => Promise<void>;
}

export const useBoardStore = create<BoardState>((set) => ({
  board: null,
  status: "idle",
  error: null,
  load: async () => {
    set({ status: "loading", error: null });
    try {
      const res = await fetch("/api/board");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const board = (await res.json()) as Board;
      set({ board, status: "ready", error: null });
    } catch (err) {
      set({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
