// Collapsed left rail — just a logo mark. No search / filter toolbar (#18).
// A wider rail with controls is out of scope for this slice.

export function Rail() {
  return (
    <aside className="flex w-14 shrink-0 flex-col items-center border-r border-slate-200 bg-white/70 py-4">
      <div
        className="flex size-9 items-center justify-center rounded-lg bg-slate-800 font-script text-lg leading-none text-amber-200 shadow-sm"
        title="tasks"
        aria-label="tasks"
      >
        t
      </div>
    </aside>
  );
}
