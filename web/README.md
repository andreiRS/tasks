# tasks board frontend (`web/`)

The browser UI for `tasks serve` (ADR-0016). React 19 + Vite + TypeScript, styled
with Tailwind CSS v4, state in Zustand, drag-and-drop via dnd-kit. The board UI
itself lands in issue #18; this scaffold (#25) proves the toolchain and the
embed/serve pipeline.

## Dependency isolation

Frontend deps live in **this nested `web/package.json`**, never the root one.
The core `tasks` CLI graph (`src/cli.ts` and everything it imports for one-shot
commands) never imports React/Vite/Tailwind/dnd-kit/Zustand, so the compiled
core stays lean (ADR-0014). The only bridge is build-time: `bun build --compile`
embeds the built `web/dist` output into the binary via a generated module (see
below). `src/serve/assets.ts` reads those embedded bytes at runtime and never
imports any frontend dep.

Pinned versions (resolved via context7): react/react-dom `^19.2`, vite `^7.1`,
`@vitejs/plugin-react` `^5`, tailwindcss + `@tailwindcss/vite` `^4.1`,
`@dnd-kit/core` `^6.3` / `@dnd-kit/sortable` `^10` / `@dnd-kit/utilities` `^3.2`,
zustand `^5`.

Tailwind v4 uses the **Vite plugin** flow (`@tailwindcss/vite` in
`vite.config.ts` + `@import "tailwindcss"` in `src/index.css`) — no
`tailwind.config.js`, no PostCSS.

## Dev loop

Two processes: the backend (`tasks serve`) and the Vite dev server. Vite serves
the UI with HMR and proxies `/api` (board reads, writes, and the `/api/events`
SSE stream) to the running backend.

```sh
# Terminal 1 — backend, in a project that has a tasks store (run `tasks init` first).
#   The default port is 4317, which web/vite.config.ts proxies to.
cd /path/to/your/project
bun run /path/to/tasks/src/cli.ts serve            # → http://127.0.0.1:4317

# Terminal 2 — frontend dev server (from this repo).
cd web
bun install        # first time only
bun run dev        # → http://127.0.0.1:5173  (open this; /api is proxied to :4317)
```

In dev there are **no embedded assets**: `tasks serve` runs API-only and Vite
fronts the UI. The asset-serving seam (`src/serve/assets.ts`) returns `null`, so
non-`/api` routes on the backend 404 — that's expected, you talk to Vite (5173),
not the backend (4317).

**Known dev-only quirk — SSE stalls after a write.** Through the Vite dev proxy
(`bun run dev`), live SSE updates can stall after a write: the proxy doesn't
reliably stream `text/event-stream` concurrently with a POST. A hard refresh
recovers the stream. This is purely a dev-proxy artifact — the compiled
single-origin production binary (`tasks serve`) is unaffected.

## Production build (single binary)

```sh
# From the repo root:
bun run build:binary
#   1. build:web        → cd web && bun install && vite build   (web/dist)
#   2. gen:web-assets   → scripts/gen-web-assets.ts writes
#                         src/serve/web-assets.generated.ts (one
#                         `import … with { type: "file" }` per built file +
#                         a route→$bunfs manifest)
#   3. bun build --compile ./src/cli.ts --outfile=dist/tasks
#                         (the generated imports make Bun embed web/dist)
```

The result `dist/tasks` is a single self-contained binary: copy it anywhere with
no `web/dist` beside it, `tasks serve`, and it serves the embedded SPA.

Manually verified (#25): compiled `dist/tasks`, copied alone to a scratch dir,
`tasks serve --port N` →
- `GET /` → 200 `text/html` (the built shell, referencing hashed assets)
- `GET /assets/index-<hash>.js` → 200 `text/javascript` (194 KB React bundle)
- `GET /assets/index-<hash>.css` → 200 `text/css`
- unknown non-`/api` route → 200 `text/html` (SPA fallback)
- missing `/assets/*` → 404
- `GET /api/board` → 200 `application/json`

`gen:web-assets` and `web/dist` are gitignored build artifacts; never commit them.

## For the board UI slice (#18)

- **Entry component**: `web/src/App.tsx` (rendered by `web/src/main.tsx` into
  `#root`). Replace `App`'s scaffold content with the six-lane board.
- **Where board code goes**: add components under `web/src/` (e.g.
  `web/src/board/`). Tailwind classes work out of the box.
- **Data layer (Zustand)**: create the store at `web/src/store.ts`. Per the #25
  decision: hold the board snapshot; SSE delivers the full authoritative
  snapshot (each message replaces store state); writes are optimistic + reconcile
  on the next snapshot, roll back + toast on failure.
- **Calling the API** (works in dev via the Vite proxy and in prod same-origin):
  - reads: `GET /api/board` → `{ lanes: Record<column, Task[]>, head, ... }`
  - move: `POST /api/tasks/:id/move` `{ column }`
  - create: `POST /api/tasks` `{ title, body?, effort? }`
  - edit: `PATCH /api/tasks/:id` `{ title?, body?, effort?, attendance? }`
  - live updates: `new EventSource("/api/events")`, each `message` is a full
    board snapshot (same shape as `GET /api/board`).
- **`--open`**: `tasks serve --open` is accepted but currently a no-op. Wiring it
  to open the served URL is deferred to #18 (kept out of #25 to avoid an
  untestable browser-launch in the suite).
```
