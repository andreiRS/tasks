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
// steals focus — the user can still read/close the drawer. `manual` popovers
// don't light-dismiss, so the toast stays until the write resolves or the user
// hits the dismiss button. (Confirmed against MDN Popover API docs via context7.)
//
// Idle = unmounted (#23 fix-up): we render the popover element ONLY when there's
// a toast. Keeping an empty popover mounted while idle would paint an empty box:
// the UA hides a closed popover with `[popover]:not(:popover-open){display:none}`,
// but our `flex` utility is an AUTHOR `display:flex` rule that wins over the UA
// rule, so a closed-but-styled popover stays visible as an empty bordered shell.
// Mounting only with content sidesteps that entirely. We call showPopover() from
// a layout effect so the element joins the top layer before paint; cleanup hides
// it if still open (covers StrictMode's mount→unmount→mount double-invoke).

import { useLayoutEffect, useRef } from "react";
import { useBoardStore } from "../store";

export function Toast() {
  const toast = useBoardStore((s) => s.toast);
  const dismiss = useBoardStore((s) => s.dismissToast);
  const ref = useRef<HTMLDivElement>(null);

  // Join the top layer when the toast div mounts, leave it on unmount. This
  // effect MUST depend on `[toast]`, not `[]`: the Toast component stays mounted
  // and returns null while idle, so the popover `<div>` (and thus `ref.current`)
  // only exists once `toast` is truthy. With `[]` the effect would run a single
  // time on first mount — when ref is still null — and never re-run when a toast
  // later appears, so showPopover() never fires and the toast stays behind
  // CardDrawer's modal dialog (#22). Keying on `[toast]` runs it the moment the
  // div mounts, before paint. showPopover throws if already-shown and hidePopover
  // if already-hidden, so guard on :popover-open. Older engines without the API
  // fall back gracefully: the element is still a normal fixed `z-50` div, just
  // not lifted above a modal dialog's backdrop.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== "function") return;
    if (!el.matches(":popover-open")) el.showPopover();
    return () => {
      if (el.matches(":popover-open")) el.hidePopover();
    };
  }, [toast]);

  if (!toast) return null;

  return (
    <div
      ref={ref}
      popover="manual"
      role="alert"
      className="fixed inset-auto bottom-4 right-4 z-50 m-0 flex max-w-sm items-start gap-3 rounded-md border border-red-200 bg-white px-4 py-3 shadow-lg"
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
