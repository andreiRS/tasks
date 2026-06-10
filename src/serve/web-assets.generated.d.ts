// Committed type stub for the GENERATED, gitignored module
// `web-assets.generated.ts` (scripts/gen-web-assets.ts; ADR-0016).
//
// On a clean checkout that real `.ts` is absent, so the runtime `import(
// "./web-assets.generated.ts")` in assets.ts would fail `tsc` with TS2307.
// Because the import carries an explicit `.ts` extension (allowed via
// `allowImportingTsExtensions`), tsc resolves the specifier to the sibling
// `web-assets.generated.d.ts` and reads these declarations. assets.ts casts
// the result via `as unknown as`, so only the shape's existence matters, but
// we mirror GeneratedManifest for clarity.
//
// When the real `.ts` IS present (after `bun run gen:web-assets`) it carries
// `// @ts-nocheck` AND is excluded from the project (tsconfig `exclude`), so
// tsc keeps using this `.d.ts` for the specifier — no duplicate declaration.

/** `$bunfs` path of the embedded index.html (SPA shell). */
export const indexHtmlPath: string;
/** route ("/assets/index-XXX.js") -> embedded `$bunfs` path. */
export const assetPaths: Record<string, string>;
