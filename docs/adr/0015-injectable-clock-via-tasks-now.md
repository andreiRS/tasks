# Injectable clock via the TASKS_NOW environment variable

Every wall-clock read in the app routes through one seam (`src/clock.ts`: `nowMs()` / `nowISO()`), which honors a `TASKS_NOW` ISO-8601 override and falls back to the real system clock. We did this because the only time-dependent behavior, the 7-day `done` cutoff window, read the real clock directly, so fixtures that pinned task timestamps to a fixed date silently rotted once that date aged past the window. Pinning a deterministic "now" alongside the fixed timestamps makes the cutoff math reproducible regardless of when the suite runs, and reuses the established env-var config pattern (`TASKS_HOME`, `NO_COLOR`/`FORCE_COLOR`) rather than threading a clock object through every call site.

## Considered Options

- **Relative-date fixtures** (compute timestamps as `now - N days`, the pattern already in `tests/cutoff.test.ts`). Rejected as the primary fix: it keeps tests green but leaves them coupled to the real clock, so time-relative logic in `summary`/`archive` stays unpinnable and a fixture near the window boundary can still flake. It remains a fine choice for tests that only need "recent vs old", not an exact instant.
- **A clock object passed via dependency injection.** Rejected: heavier than the problem warrants and inconsistent with how the rest of the app reads config (env vars, read at the point of use).

## Consequences

- `TASKS_NOW` ships in the production binary. It is intended for tests but is a legitimate "freeze the clock" lever for anyone; an unparseable value is ignored and falls back to the real clock.
- New time-dependent code must read `nowMs()`/`nowISO()` from `src/clock.ts`, never `Date.now()` / `new Date()` directly.
