// Slack-style user menu pinned to the bottom of the left rail (#29). An avatar
// button opens a popover anchored to the right of the rail. For now the menu is
// a placeholder shell: it carries one working example control — a
// Light/Dark/System appearance toggle whose choice persists to localStorage —
// plus a couple of inert rows reserved for future tools. Full board theming is a
// later pass; selecting Dark here remembers the choice but doesn't repaint yet.

import { useEffect, useRef, useState } from "react";

type Theme = "light" | "dark" | "system";
const THEMES: Theme[] = ["light", "dark", "system"];
const THEME_KEY = "tasks-theme";

function loadTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Persist the choice and stamp it on <html> so a future theming pass can hook
  // off [data-theme]. No dark styles ship yet, so this is a no-op visually.
  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Close on Escape and on a click outside the wrapper (button + popover).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative mt-auto">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu"
        className="flex size-9 items-center justify-center rounded-full bg-slate-200 text-slate-600 ring-1 ring-black/5 transition-colors hover:bg-slate-300 hover:text-slate-800"
      >
        {/* Generic avatar glyph — no auth/user model, so this is the board's seat. */}
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-5" aria-hidden>
          <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.7-8 6v1h16v-1c0-3.3-3.6-6-8-6Z" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-0 left-[calc(100%+0.5rem)] z-30 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-800 shadow-xl"
        >
          {/* Identity header — stands in for the tracked project/board. */}
          <div className="flex items-center gap-2.5 border-b border-slate-100 px-3 py-3">
            <div className="flex size-8 items-center justify-center rounded-md bg-slate-800 font-script text-base leading-none text-amber-200">
              t
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">tasks</div>
              <div className="truncate text-xs text-slate-400">this board</div>
            </div>
          </div>

          {/* Appearance — the one live control (placeholder otherwise). */}
          <div className="px-3 py-2.5">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              appearance
            </div>
            <div className="inline-flex w-full gap-1 rounded-lg bg-slate-100 p-1">
              {THEMES.map((t) => {
                const selected = theme === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTheme(t)}
                    aria-pressed={selected}
                    className={`flex-1 rounded-md px-2 py-1 text-xs capitalize transition-colors ${
                      selected
                        ? "bg-white font-semibold text-slate-800 shadow-sm"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Reserved for future tools — inert placeholders. */}
          <div className="border-t border-slate-100 py-1">
            {["Preferences", "Keyboard shortcuts"].map((label) => (
              <button
                key={label}
                type="button"
                disabled
                role="menuitem"
                className="flex w-full cursor-not-allowed items-center justify-between px-3 py-1.5 text-left text-sm text-slate-400"
              >
                {label}
                <span className="text-[10px] uppercase tracking-wide text-slate-300">soon</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
