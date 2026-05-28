# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-1.0 the surface may still change between minor
versions; breaking changes will be called out explicitly here.

## [Unreleased]

## [0.1.0] - 2026-05-28

First versioned release. The Store, validator, every read command
(`show`, `list`, `board`, `next`, `export`, `summary`), every mutating
command (`init`, `new`, `mv`, `edit`, `set`, `link`, `unlink`, `rm`,
`undo`, `archive`), and `doctor` are in place.

### Added

- `tasks export --json`: whole-Store JSON dump for agents. Returns
  every live Task (frontmatter + body + parsed acceptance criteria), a
  `reverse_deps` index, the Store HEAD commit SHA, and a
  `schema_version`. Archived Tasks are excluded by default; any
  Archived Task referenced as a Dep by a live Task is included as an
  Archive Stub (`{ id, uuid, title, column: "archive", complete: true }`)
  so the Dep graph is never dangling. Tasks are grouped by Column in
  fixed order then sorted by `created_at` ascending for deterministic
  diffs across invocations. `--include-archived` opts the full Archive
  in; `--columns a,b,c` restricts the live set. See
  [ADR-0011](./docs/adr/0011-export-shape-and-defaults.md).
- `tasks summary --json`: compact Store digest with per-Column counts,
  the last 10 Tasks by `updated_at` (`recent`), and live-Column Tasks
  in `doing`/`blocked`/`review` untouched for 14+ days (`stale`).
  Separate envelope from `export`: no `tasks` array. Thresholds
  overridable via `--recent N` and `--stale <duration>`.
- `tasks --version` / `tasks -V` / `tasks version`: prints the CLI
  version sourced from `package.json`.
- `Export`, `Archive Stub`, and `Summary` glossary entries in
  `CONTEXT.md`.
- `docs/adr/0011-export-shape-and-defaults.md` records the contract
  decisions behind `export` and `summary`.

[Unreleased]: https://github.com/USER/REPO/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/USER/REPO/releases/tag/v0.1.0
