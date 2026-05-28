# Acceptance Criteria live in the Body, not Frontmatter

Acceptance Criteria are written as a conventional `## Acceptance Criteria` section in the markdown Body. On `--json` reads they are extracted by a hand-rolled, fence-aware, case-insensitive scanner and surfaced as a top-level `acceptance_criteria` string. Chosen over a Frontmatter field because criteria are often multi-line markdown with lists and code samples, which YAML handles poorly and humans dislike editing; keeping them in the Body lets `$EDITOR` workflows feel like writing a doc, while the parser still gives agents structured access.

## Consequences

- The parsing rules (heading match, fence handling, section bounds) are part of the contract and must stay stable; agents will rely on them.
- A markdown AST library is intentionally not used; a small state machine is simpler to ship inside the compiled binary and easier to honor literally.
