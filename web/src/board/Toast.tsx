// Minimal dismissable toast for write failures (#19). It surfaces the server
// error envelope's `code` plus its message after a move snaps back. #23 owns the
// full write-failure UX; this stays deliberately small but real.

import { useBoardStore } from "../store";

export function Toast() {
  const toast = useBoardStore((s) => s.toast);
  const dismiss = useBoardStore((s) => s.dismissToast);

  if (!toast) return null;

  return (
    <div
      role="alert"
      className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-md border border-red-200 bg-white px-4 py-3 shadow-lg"
    >
      <div className="min-w-0">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-wide text-red-600">
          {toast.code}
        </p>
        <p className="mt-0.5 text-sm text-slate-700 break-words">{toast.message}</p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="dismiss"
        className="shrink-0 rounded px-1 text-slate-400 hover:text-slate-700"
      >
        ✕
      </button>
    </div>
  );
}
