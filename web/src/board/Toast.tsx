// Dismissable write-failure toast (#19, generalized in #23). It surfaces the
// server error envelope's `code` plus its message after any write (move/create/
// edit) snaps back.
//
// Top-layer rendering (#23, AC1 for the edit path): the toast must show even
// when CardDrawer's `<dialog>.showModal()` is open. A modal dialog sits in the
// browser TOP LAYER, so a plain `position:fixed z-50` div paints BEHIND its
// backdrop and the user can't see the toast. The fix is a MANUAL popover
// (`popover="manual"` shown via `showPopover()`): per the Popover API spec a
// shown popover joins the top layer, and the element placed in the top layer
// LAST stacks on top — so a popover shown after the dialog renders ABOVE it.
// Crucially, popovers are NON-modal (only modal `<dialog>` makes the rest of the
// page inert), so the drawer beneath stays fully interactive and the toast never
// steals focus — the user can still read/close the drawer. We drive show/hide
// off the store's `toast`; `manual` popovers don't light-dismiss, so the toast
// stays until the write resolves or the user hits the dismiss button.
// (Confirmed against MDN Popover API docs via context7.)

import { useEffect, useRef } from "react";
import { useBoardStore } from "../store";

export function Toast() {
  const toast = useBoardStore((s) => s.toast);
  const dismiss = useBoardStore((s) => s.dismissToast);
  const ref = useRef<HTMLDivElement>(null);

  // Mirror the store's `toast` into the popover's top-layer visibility. We keep
  // the element mounted (so showPopover/hidePopover have a target) and toggle it
  // imperatively. showPopover throws if already-shown / hidePopover if already-
  // hidden, so guard on matches(":popover-open"). Older engines without the API
  // fall back gracefully: the element is still a normal fixed div (see below).
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== "function") return;
    const open = el.matches(":popover-open");
    if (toast && !open) el.showPopover();
    else if (!toast && open) el.hidePopover();
  }, [toast]);

  // Render nothing-but-the-shell when there's no toast: the element must stay in
  // the DOM for the popover handle, but we don't paint content. `popover` hides
  // it via `display:none` until shown, so an empty hidden div is inert.
  return (
    <div
      ref={ref}
      popover="manual"
      role="alert"
      className="fixed inset-auto bottom-4 right-4 z-50 m-0 flex max-w-sm items-start gap-3 rounded-md border border-red-200 bg-white px-4 py-3 shadow-lg"
    >
      {toast && (
        <>
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
        </>
      )}
    </div>
  );
}
