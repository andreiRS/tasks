# CONTEXT Format

`CONTEXT.md` is a glossary. It is the canonical reference for the domain language used in code, commit messages, ADRs, and agent prompts. It is **not** a spec, a scratch pad, or a place for implementation decisions. Implementation lives in the code; decisions live in `docs/adr/`.

## Template

```md
# {Context Name}

{One or two sentences describing what this context is and why it exists.}

## Language

**Term**:
A one or two sentence definition. Concrete, not aspirational.
_Avoid_: synonym1, synonym2

**AnotherTerm**:
A one or two sentence definition.
_Avoid_: synonym1
```

## Rules

- One term per entry. If two terms keep getting confused, define them both and list each in the other's `_Avoid_`.
- Definitions are short. If you need a paragraph, the term is too broad, split it.
- `_Avoid_` lists the synonyms readers should *not* use, so the canonical term wins by repetition.
- No implementation details. "A Task is a markdown file with YAML frontmatter" is fine, the YAML schema is not.
- Cross-reference other terms by capitalising them in definitions. "A Store holds Tasks across Columns."
- Update on the spot. When a new term gets resolved in conversation, add it immediately; do not batch.
- Remove or rename terms when they stop matching the code. A stale glossary is worse than no glossary.

## Multi-context layout

If a repo grows multiple bounded contexts, add a `CONTEXT-MAP.md` at the root pointing to each context's own `CONTEXT.md`. Until that happens, keep a single `CONTEXT.md` at the root.
