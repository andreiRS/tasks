# TypeScript on Bun, compiled to a single binary, with a deliberately small dependency surface

`tasks` is written in TypeScript on Bun and shipped via `bun build --compile` as a single native executable distributed through GitHub releases (no npm publish in v1). Git is invoked by shelling out to the system `git` binary via `Bun.spawn`, with no git-library dependency. The dependency surface is kept minimal on purpose: stdlib `util.parseArgs` for argument parsing with hand-rolled subcommand dispatch (chosen over Commander/Citty to keep the compiled binary lean), the `yaml` package via its `Document` API for frontmatter (so rewrites preserve field ordering and quoting), stdlib `crypto.randomUUID()` for UUIDs (no `uuid` dep), `ink` for rendering `list`/`board`/`show`/`next` as static output (chosen over picocolors + hand-rolled layout to leave room for richer renderings without rewriting the render layer), and `bun:test` for the E2E suite. The Acceptance Criteria parser is a hand-rolled, fence-aware line scanner rather than a markdown AST library: `remark` is rejected because it would pull a large AST toolchain into the binary for a job a small state machine handles, and a literal parser makes the documented rules (see ADR-0007) easier to honor exactly.

## Consequences

- External binary dependencies are `git` (assumed present) and `flock` (see ADR-0013).
- `engines` is omitted from `package.json` (Bun-only, ships a compiled binary, so a Node version range would mislead); types come from `@types/bun`; tsconfig baseline is `module: esnext`, `moduleResolution: bundler`, `target: esnext`, `strict: true`.
- The binary name `tasks` risks colliding with other tools on `$PATH`; verify before any wider distribution.
