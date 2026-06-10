import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Frontend build for `tasks serve`. Output (web/dist) is embedded into the
// single compiled `tasks` binary at `bun build --compile` time (see the root
// `build:binary` script and src/serve/assets.ts). In dev, this same config
// runs the Vite dev server which proxies /api to a running `tasks serve`.
export default defineConfig({
  // Vite v4 plugin flow (confirmed via context7): the Tailwind v4 setup is a
  // Vite plugin + `@import "tailwindcss"` in CSS. No tailwind.config.js / PostCSS.
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Dev: forward API + SSE to a live `tasks serve` (default port 4317).
      // ws:false is fine; SSE is plain HTTP, not a websocket.
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
      },
    },
  },
});
