# Status is encoded by the enclosing directory, not a frontmatter field

A Task's Column is its parent directory (`backlog/`, `ready/`, `doing/`, `blocked/`, `review/`, `done/`); there is no `status` field in Frontmatter. Moving Columns is a `git mv`, which shows up as a rename in `git log` and makes the change cheap to review. Chosen over a frontmatter field so the file system itself is the kanban, listing a Column is `ls`, and Frontmatter writes are avoided on the most frequent mutation (`mv`).

## Consequences

- The six Columns are fixed in v1; adding or renaming a Column is a directory migration, not a config flip.
- A Task cannot be in two Columns at once by construction.
