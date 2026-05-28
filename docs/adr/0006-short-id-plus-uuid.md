# Two identifiers per Task: Short ID for humans, UUID for references

Each Task carries a per-Store monotonically increasing Short ID (a small integer, never reused) **and** a globally stable v4 UUID. CLI inputs accept either, auto-detected by shape; Dependencies in Frontmatter always reference UUIDs. Chosen so humans can type `tasks mv 17 doing` while every internal reference survives renumbering, store migrations, or display-ID schemes we might want later.

## Consequences

- Short IDs are a display concern; renaming or restructuring them is safe because no other Task points at them.
- Agents should default to UUIDs in scripts to be robust against future ID changes, even though both shapes are accepted today.
