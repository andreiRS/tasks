import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { embeddedFiles } from "bun";

/**
 * The asset-serving seam for `tasks serve` (issue #25).
 *
 * `serve` must host the SPA shell on every non-`/api` route. There are two
 * sources of built assets, and exactly one is active at a time:
 *
 *  1. PROD (the compiled `tasks` binary): the Vite build output is embedded at
 *     `bun build --compile` time and exposed as `Bun.embeddedFiles`. The build
 *     script (root `build:web` + `build:binary`) generates a tiny module of
 *     `import ... with { type: "file" }` statements (one per built file) so Bun
 *     embeds them; that module also exports the route manifest. We load it
 *     dynamically so the source tree still compiles when it hasn't been
 *     generated (i.e. in dev and in `bun run src/cli.ts`).
 *
 *  2. DEV (Vite dev server fronts the UI and proxies `/api` here): there are NO
 *     embedded assets. `loadAssets` returns `null` and `serve` simply does not
 *     serve a shell — unknown non-`/api` routes 404, which is correct because
 *     the browser is talking to the Vite dev server, not to `tasks serve`.
 *
 * A third path exists only to make the seam testable at the HTTP boundary
 * without a multi-second compile in every `bun run test`: if `TASKS_WEB_DIST`
 * points at a built `web/dist` directory, assets are read from disk using the
 * SAME route/content-type/fallback rules as the embedded path. The compiled
 * binary ignores this env var (it always has embedded files). This is the only
 * dev-affordance; production correctness is verified manually by compiling the
 * binary and curling it (see web/README.md).
 *
 * How `serve` decides embedded-vs-absent: it calls `loadAssets()` once at boot.
 * Non-null → serve the shell + hashed assets + SPA fallback. Null → API only.
 */

export interface AssetBundle {
  /** The SPA shell, served at `/` and as the SPA fallback for unknown routes. */
  indexHtml: string;
  /**
   * Hashed build artifacts keyed by their request path (e.g.
   * "/assets/index-CY8-29gH.js"), each a Blob with a stable content type.
   */
  assets: Map<string, Blob>;
}

/** Map a file extension to a content type for the built asset set. */
export function contentTypeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  return "application/octet-stream";
}

/**
 * Resolve the active asset bundle, or `null` when none is present (dev).
 * Order: explicit `TASKS_WEB_DIST` (test/dev affordance) → embedded files
 * (compiled binary) → null.
 */
export async function loadAssets(): Promise<AssetBundle | null> {
  const distDir = process.env.TASKS_WEB_DIST;
  if (distDir && existsSync(join(distDir, "index.html"))) {
    return loadFromDir(distDir);
  }
  return loadFromEmbedded();
}

/** Read a built `web/dist` from disk (test/dev affordance). */
async function loadFromDir(distDir: string): Promise<AssetBundle> {
  const indexHtml = await Bun.file(join(distDir, "index.html")).text();
  const assets = new Map<string, Blob>();
  const assetsDir = join(distDir, "assets");
  if (existsSync(assetsDir)) {
    for (const name of readdirSync(assetsDir)) {
      assets.set(`/assets/${name}`, Bun.file(join(assetsDir, name)));
    }
  }
  return { indexHtml, assets };
}

/**
 * Read assets embedded in the compiled binary. Returns null when nothing was
 * embedded (running from source). The generated manifest module
 * (`web-assets.generated.ts`, gitignored, created by the build script) imports
 * every built file with `{ type: "file" }` so Bun embeds it, and exports a
 * route→`$bunfs` path map plus the index.html `$bunfs` path.
 */
async function loadFromEmbedded(): Promise<AssetBundle | null> {
  // The authoritative "am I a compiled binary with assets" signal: Bun only
  // populates `embeddedFiles` in a `--compile`d executable. Running from source
  // (`bun run src/cli.ts`, the test harness, dev) leaves it empty even if a
  // stray generated module is present, so dev correctly gets no SPA shell.
  if (embeddedFiles.length === 0) return null;

  let manifest: GeneratedManifest | null = null;
  try {
    // Literal specifier so Bun's `--compile` bundler statically follows it and
    // embeds the assets it imports (a variable specifier would NOT be followed,
    // leaving the binary asset-less). The generated artifact is created by
    // scripts/gen-web-assets.ts before compile and carries `@ts-nocheck` (it
    // imports raw .js/.css/.html with no declarations); it is excluded from the
    // repo (gitignored), so when absent (dev / `bun run src/cli.ts`) this import
    // rejects and we return null. tsc still resolves the path when the file
    // exists locally — see scripts/gen-web-assets.ts for why it's `@ts-nocheck`.
    manifest = (await import("./web-assets.generated.ts")) as unknown as GeneratedManifest;
  } catch {
    return null;
  }
  if (!manifest || !manifest.indexHtmlPath) return null;

  const indexHtml = await Bun.file(manifest.indexHtmlPath).text();
  const assets = new Map<string, Blob>();
  for (const [route, bunfsPath] of Object.entries(manifest.assetPaths)) {
    assets.set(route, Bun.file(bunfsPath));
  }
  return { indexHtml, assets };
}

interface GeneratedManifest {
  /** `$bunfs` path of the embedded index.html. */
  indexHtmlPath: string;
  /** route ("/assets/index-XXX.js") → embedded `$bunfs` path. */
  assetPaths: Record<string, string>;
}
