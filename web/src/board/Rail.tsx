// Collapsed left rail — logo mark at the top, a Slack-style user menu pinned to
// the bottom (#29). No search / filter toolbar (#18).

import { UserMenu } from "./UserMenu";

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
      <UserMenu />
    </aside>
  );
}
