# Releasing

How to publish a release of `tasks`. Pre-1.0 the surface is still
moving, so versions land deliberately, not on every merge.

## Versioning rules (pre-1.0)

- `0.x.y` — `x` bumps for any user-visible change (new command, flag,
  output shape, removal). `y` bumps for pure fixes with no surface
  change.
- Breaking changes are allowed in `x` bumps but must be called out
  under `### Changed` or `### Removed` in `CHANGELOG.md`.
- Never move or reuse a published tag. If a tag is wrong, bump forward
  and publish a new one.

## Day-to-day flow (no release)

- Land work on `main` as normal commits.
- Append entries under `## [Unreleased]` in `CHANGELOG.md`. Group by
  `Added` / `Changed` / `Fixed` / `Removed`.
- Leave `package.json` `version` at the *next* target you're working
  toward (e.g. `0.1.0` while everything in `[Unreleased]` will ship
  as `0.1.0`).

## Publishing a release

1. **Pick the version.** Bump `package.json` if the target shifted
   (e.g. an extra feature pushed `0.1.0` to `0.2.0`).
2. **Promote the changelog.** Rename `## [Unreleased]` to
   `## [X.Y.Z] - YYYY-MM-DD`, leave a fresh empty `## [Unreleased]`
   block above it, and update the compare links at the bottom of
   `CHANGELOG.md`:
   ```markdown
   [Unreleased]: https://github.com/andreiRS/tasks/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/andreiRS/tasks/releases/tag/vX.Y.Z
   ```
3. **Verify.** `bun test` green, `bun run src/cli.ts --version` prints
   the new version.
4. **Commit.** Single commit, message `chore(release): vX.Y.Z`.
5. **Tag from that commit.**
   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```
6. **Publish the GitHub Release.**
   ```sh
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-from-tag
   ```
   Or use `--notes-file -` with the changelog slice piped in for richer
   release notes.
7. **Open the next cycle.** Bump `package.json` to the next planned
   target (`0.(X+1).0` or `0.X.(Y+1)`) in a follow-up commit so the
   binary on `main` no longer claims to be the released version.

## Useful commands

```sh
# See what would ship since the last release
git log --oneline vX.Y.Z..HEAD
git diff vX.Y.Z..HEAD -- CHANGELOG.md package.json

# List tags / show a tag's commit + message
git tag -l
git show vX.Y.Z

# Inspect releases on GitHub
gh release list
gh release view vX.Y.Z

# Edit release notes after the fact (safe; doesn't move the tag)
gh release edit vX.Y.Z --notes-file notes.md
```

## Undoing a bad release

Only do this if no one has pulled the tag yet. Otherwise, bump forward
and publish a new patch instead.

```sh
# Delete the GitHub Release (keeps the tag)
gh release delete vX.Y.Z

# Delete the tag locally and on the remote
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```
