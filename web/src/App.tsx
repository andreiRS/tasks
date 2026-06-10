import { useEffect, useState } from "react";

/**
 * Scaffold shell for `tasks serve` (issue #25). This is intentionally minimal
 * but NON-trivial: a real React component with state + an effect that calls the
 * live `/api/board` endpoint, with Tailwind utility classes actually applied so
 * the compiled CSS asset is exercised. Issue #18 replaces this with the real
 * six-lane board (see web/README.md for where board code + the Zustand store go).
 */
export function App() {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [columns, setColumns] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    fetch("/api/board")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((snap: { lanes?: Record<string, unknown[]> }) => {
        if (!alive) return;
        setColumns(Object.keys(snap.lanes ?? {}));
        setStatus("ok");
      })
      .catch(() => alive && setStatus("error"));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="min-h-screen bg-slate-100 p-8 font-sans text-slate-800">
      <h1 className="text-2xl font-bold tracking-tight">tasks board</h1>
      <p className="mt-2 text-sm text-slate-500">
        Scaffold shell. The six-lane board lands in #18.
      </p>
      <div className="mt-4 inline-flex items-center gap-2 rounded-md bg-white px-3 py-2 shadow">
        <span
          className={
            status === "ok"
              ? "size-2 rounded-full bg-green-500"
              : status === "error"
                ? "size-2 rounded-full bg-red-500"
                : "size-2 rounded-full bg-amber-400"
          }
        />
        <span className="text-sm">
          {status === "loading"
            ? "contacting /api/board…"
            : status === "ok"
              ? `connected — ${columns.length} columns`
              : "could not reach /api/board"}
        </span>
      </div>
    </main>
  );
}
