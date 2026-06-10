// Card detail drawer (#22). A right-side panel built on the native <dialog>
// element (same pattern as NewTaskModal: showModal() gives focus-trap +
// Escape-to-close + ::backdrop for free), positioned to the right edge.
//
// Two modes:
//   - View: rendered-markdown body (GFM checklist, read-only), plus read-only
//     title, column, effort, attendance, forward deps (task.blockedBy) and
//     reverse deps (DERIVED here: tasks whose blockedBy includes this id).
//   - Edit: title (required) / body (raw markdown) / effort picker / attendance
//     toggle. Column and deps are NOT editable. Save dispatches an optimistic
//     editTask through the store; cancel returns to view. Mirrors NewTaskModal's
//     validation, disabled-submit, and submittingRef double-submit guard.
//
// The drawer reads the LIVE card from the board by selectedUuid each render, so
// reconciled SSE updates and a confirmed edit's values flow straight through.

import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { useBoardStore } from "../store";
import type { Attendance, BoardTask, Effort } from "./types";
import { EFFORT_DOT } from "./effort";
import { Markdown } from "./Markdown";

const EFFORTS: Effort[] = ["low", "medium", "high"];

export function CardDrawer() {
  const selectedUuid = useBoardStore((s) => s.selectedUuid);
  const board = useBoardStore((s) => s.board);
  const closeCard = useBoardStore((s) => s.closeCard);
  const editTask = useBoardStore((s) => s.editTask);

  // The live card by selectedUuid, found across all lanes. A reconciled snapshot
  // updates this in place; if the uuid vanished, applySnapshot already cleared
  // selectedUuid, but guard here too.
  const allTasks = useMemo(
    () => (board ? board.columns.flatMap((c) => board.lanes[c] ?? []) : []),
    [board],
  );
  const card = selectedUuid ? allTasks.find((t) => t.uuid === selectedUuid) : undefined;

  // Reverse deps: other tasks whose blockedBy includes THIS card's short id.
  // The snapshot only carries forward deps, so we derive the reverse edge here.
  const reverseDeps = useMemo(() => {
    if (!card) return [];
    return allTasks
      .filter((t) => t.uuid !== card.uuid && t.blockedBy.includes(card.id))
      .map((t) => t.id)
      .sort((a, b) => a - b);
  }, [allTasks, card]);

  const open = card != null;

  return (
    <Drawer key={card?.uuid ?? "closed"} open={open} onClose={closeCard}>
      {card && (
        <DrawerBody
          card={card}
          reverseDeps={reverseDeps}
          onClose={closeCard}
          onSave={editTask}
        />
      )}
    </Drawer>
  );
}

/** The native-dialog shell: drives showModal()/close() from `open`, routes
 *  Escape and backdrop-click through onClose (same as NewTaskModal). */
function Drawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="card-drawer-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      // Pin to the right edge, full-height panel. The default <dialog> centering
      // margins are overridden so it reads as a side drawer over a dim backdrop.
      className="m-0 ml-auto h-full max-h-none w-[min(34rem,94vw)] rounded-none border-l border-slate-200 bg-[#faf8f2] p-0 text-slate-800 shadow-2xl backdrop:bg-black/30"
    >
      {children}
    </dialog>
  );
}

/** Inner content: view + edit modes for a concrete card. Keyed by uuid so a
 *  different card opening resets local edit state. */
function DrawerBody({
  card,
  reverseDeps,
  onClose,
  onSave,
}: {
  card: BoardTask;
  reverseDeps: number[];
  onClose: () => void;
  onSave: (
    task: BoardTask,
    patch: { title?: string; body?: string; effort?: Effort; attendance?: Attendance },
  ) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);

  // Edit-mode form state, seeded from the card on entering edit mode.
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [effort, setEffort] = useState<Effort>(card.effort);
  const [attendance, setAttendance] = useState<Attendance>(card.attendance);
  const [showTitleError, setShowTitleError] = useState(false);
  // Double-submit guard (mirrors NewTaskModal): a held/double Enter could fire
  // handleSave twice before the mode flip re-renders.
  const submittingRef = useRef(false);

  const titleValid = title.trim().length > 0;

  function enterEdit() {
    setTitle(card.title);
    setBody(card.body);
    setEffort(card.effort);
    setAttendance(card.attendance);
    setShowTitleError(false);
    submittingRef.current = false;
    setEditing(true);
  }

  function handleSave(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!titleValid) {
      setShowTitleError(true);
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    // Pass the full candidate set; the store diffs against the live card and
    // fires no request if nothing changed (avoids a spurious MISSING_FIELD).
    void onSave(card, { title: title.trim(), body, effort, attendance });
    setEditing(false);
  }

  const isAgent = card.attendance === "unattended";

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-black/10 px-1.5 py-0.5 font-mono text-[12px] font-semibold tracking-tight text-slate-700">
            #{card.id}
          </span>
          <span className="text-xs uppercase tracking-wide text-slate-400">{card.column}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="-mr-1 rounded px-1.5 text-slate-400 hover:text-slate-700"
        >
          ✕
        </button>
      </div>

      {editing ? (
        <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
          {/* Title */}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">title</span>
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (showTitleError && e.target.value.trim()) setShowTitleError(false);
              }}
              aria-invalid={showTitleError}
              aria-describedby={showTitleError ? "card-title-error" : undefined}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-300"
            />
            {showTitleError && (
              <span id="card-title-error" className="text-xs text-red-600">
                title is required
              </span>
            )}
          </label>

          {/* Body */}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              body <span className="font-normal normal-case text-slate-400">(markdown)</span>
            </span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="resize-y rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-[13px] outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-300"
            />
          </label>

          {/* Effort picker */}
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">effort</legend>
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
                    <span
                      className="size-2.5 rounded-full ring-1 ring-black/10"
                      style={{ backgroundColor: EFFORT_DOT[e].color }}
                    />
                    {e}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Attendance toggle — hand the task to agents (unattended) or keep it
              human-attended. */}
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              attendance
            </legend>
            <div className="mt-1 flex gap-2">
              {(["attended", "unattended"] as Attendance[]).map((a) => {
                const selected = attendance === a;
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAttendance(a)}
                    aria-pressed={selected}
                    className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      selected
                        ? "border-slate-400 bg-white font-semibold text-slate-800"
                        : "border-slate-200 bg-transparent text-slate-500 hover:border-slate-300"
                    }`}
                  >
                    <span aria-hidden>{a === "unattended" ? "🤖" : "🙂"}</span>
                    {a === "unattended" ? "agent" : "human"}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Actions */}
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
              cancel
            </button>
            <button
              type="submit"
              disabled={!titleValid}
              className="rounded-md bg-slate-800 px-4 py-1.5 text-sm font-semibold text-amber-100 shadow-sm hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              save
            </button>
          </div>
        </form>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
          <div className="flex items-start justify-between gap-3">
            <h2 id="card-drawer-title" className="font-script text-2xl leading-snug text-slate-800">
              {card.title}
            </h2>
            <button
              type="button"
              onClick={enterEdit}
              className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:border-slate-400 hover:bg-white"
            >
              edit
            </button>
          </div>

          {/* Meta row: effort + attendance */}
          <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
            <span className="flex items-center gap-1.5">
              <span
                className="size-2.5 rounded-full ring-1 ring-black/10"
                style={{ backgroundColor: EFFORT_DOT[card.effort].color }}
              />
              {card.effort} effort
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden>{isAgent ? "🤖" : "🙂"}</span>
              {isAgent ? "agent (unattended)" : "human (attended)"}
            </span>
          </div>

          {/* Deps — read-only, both directions. */}
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                blocked by
              </span>
              {card.blockedBy.length > 0 ? (
                <span className="font-mono text-slate-700">
                  {card.blockedBy.map((b) => `#${b}`).join(", ")}
                </span>
              ) : (
                <span className="text-slate-400">nothing</span>
              )}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                blocks
              </span>
              {reverseDeps.length > 0 ? (
                <span className="font-mono text-slate-700">
                  {reverseDeps.map((b) => `#${b}`).join(", ")}
                </span>
              ) : (
                <span className="text-slate-400">nothing</span>
              )}
            </div>
          </div>

          {/* Rendered-markdown body (GFM checklist, read-only). */}
          <div className="border-t border-slate-200 pt-3">
            {card.body.trim() ? (
              <Markdown>{card.body}</Markdown>
            ) : (
              <p className="text-sm italic text-slate-400">no description</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
