# Archive is a sibling directory, not a 7th Column

Long-lived `done/` accumulates and clutters the live store, but the six Columns are fixed by ADR-0003 ("status encoded by directory") and the PRD explicitly lists configurable column sets as Out of Scope. We add an `archive/` directory inside the Store that sits next to the six Column directories but is **not** a Column: Transitions never target it, `list`/`board`/`next` skip it by default, and the only way in is the dedicated `tasks archive` command. The Column vocabulary stays at six; "archived" becomes a separate concept (a tombstone location for tasks the user is done thinking about), preserving ADR-0003's invariant that a Task's Column equals its enclosing directory among the six.

## Consequences

- A Task's directory now answers two questions, not one: which of the six Columns it is in (if any) or whether it has been archived. The Store's read paths must distinguish "iterate Columns" from "iterate all Task locations including archive" per use case.
- Archived tasks still count as Complete for blocking purposes (they were in `done/` immediately before archive). Dep resolution in `tasks next` and `show`'s `deps:`/`blocks:` blocks therefore scan `archive/` alongside `done/`.
- Archive is one-way in v1: there is no `unarchive` command. Recovery is `git mv` + commit by hand, audited via `git log` like any other manual edit to the Store.
