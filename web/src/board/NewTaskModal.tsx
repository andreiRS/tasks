// New-task modal (#21). Title (required), markdown body (raw textarea — #22 owns
// rendering), and a low/medium/high effort picker (default medium). Submitting
// dispatches an optimistic create through the store and closes; cancel and
// Escape close without creating.
//
// Built on the native <dialog> element driven by a ref + effect (React 19 docs'
// pattern): showModal() gives us a focus trap and Escape-to-close for free, and
// the ::backdrop. We mirror the dialog's open/closed to the `open` prop and
// focus the title input on open.

import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useBoardStore } from "../store";
import type { Effort } from "./types";
import { EffortBadge } from "./effort";

const EFFORTS: Effort[] = ["low", "medium", "high"];

export function NewTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createTask = useBoardStore((s) => s.createTask);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // In-flight guard: a held/double-pressed Enter can fire handleSubmit twice
  // before the close re-render lands, which would create two tasks.
  const submittingRef = useRef(false);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [effort, setEffort] = useState<Effort>("medium");
  // Shown only after a submit attempt with an empty title (inline feedback).
  const [showTitleError, setShowTitleError] = useState(false);

  const titleValid = title.trim().length > 0;

  // Drive the native dialog from the `open` prop. showModal() throws if called
  // on an already-open dialog, so guard on .open; the cleanup/close mirrors it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Focus the title input once the dialog is shown.
      titleRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Reset the form each time the modal opens, so a prior cancel/success doesn't
  // leak stale values into the next open.
  useEffect(() => {
    if (open) {
      setTitle("");
      setBody("");
      setEffort("medium");
      setShowTitleError(false);
      submittingRef.current = false;
    }
  }, [open]);

  function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!titleValid) {
      setShowTitleError(true);
      titleRef.current?.focus();
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    void createTask({ title: title.trim(), body, effort });
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="new-task-title"
      // The native Escape key and backdrop click both fire a `cancel` event;
      // route them through onClose so React state stays the source of truth.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // Close when clicking the backdrop (clicks on the dialog itself land on a
      // child, so target === dialog only for the backdrop region).
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      className="m-auto w-[min(32rem,92vw)] rounded-lg border border-slate-200 bg-[#faf8f2] p-0 text-slate-800 shadow-2xl backdrop:bg-black/30"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
        <h2 id="new-task-title" className="font-script text-2xl text-slate-800">
          new task
        </h2>

        {/* Title (required) */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            title
          </span>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (showTitleError && e.target.value.trim()) setShowTitleError(false);
            }}
            aria-invalid={showTitleError}
            aria-describedby={showTitleError ? "new-task-title-error" : undefined}
            placeholder="what needs doing?"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-300"
          />
          {showTitleError && (
            <span id="new-task-title-error" className="text-xs text-red-600">
              title is required
            </span>
          )}
        </label>

        {/* Body (raw markdown — rendering is #22's job) */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            body <span className="font-normal normal-case text-slate-400">(markdown)</span>
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="details, context, acceptance…"
            className="resize-y rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-[13px] outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-300"
          />
        </label>

        {/* Effort picker (default medium) */}
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            effort
          </legend>
          <div className="mt-1 flex gap-2">
            {EFFORTS.map((e) => {
              const selected = effort === e;
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEffort(e)}
                  aria-pressed={selected}
                  className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm capitalize transition-colors ${
                    selected
                      ? "border-slate-400 bg-white font-semibold text-slate-800"
                      : "border-slate-200 bg-transparent text-slate-500 hover:border-slate-300"
                  }`}
                >
                  <EffortBadge effort={e} />
                  {e}
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Actions */}
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:text-slate-800"
          >
            cancel
          </button>
          <button
            type="submit"
            disabled={!titleValid}
            className="rounded-md bg-slate-800 px-4 py-1.5 text-sm font-semibold text-amber-100 shadow-sm hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            create
          </button>
        </div>
      </form>
    </dialog>
  );
}
