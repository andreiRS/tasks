# ADR Format

ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`, `0002-slug.md`, etc.

Create the `docs/adr/` directory lazily, only when the first ADR is needed.

## Template

```md
# {Short title of the decision}

{1 to 3 sentences: what is the context, what did we decide, and why.}
```

That is it. An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why*, not in filling out sections.

## Optional sections

Only include these when they add genuine value. Most ADRs will not need them.

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`), useful when decisions are revisited.
- **Considered Options**, only when the rejected alternatives are worth remembering.
- **Consequences**, only when non-obvious downstream effects need to be called out.

## Numbering

Scan `docs/adr/` for the highest existing number and increment by one.

## When to write an ADR

All three must be true:

1. **Hard to reverse**, the cost of changing your mind later is meaningful.
2. **Surprising without context**, a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off**, there were genuine alternatives and you picked one for specific reasons.

If a decision is easy to reverse, skip it. If it is not surprising, nobody will wonder why. If there was no real alternative, there is nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "The store is one git repo per project." "Tasks are markdown files, status encoded by directory."
- **Integration patterns.** How the CLI, store, and validator communicate.
- **Technology choices with lock-in.** Runtime, distribution model, parser library, lock primitive. Not every dependency, just the ones that would take real effort to swap.
- **Boundary and scope decisions.** "The CLI is the only sanctioned writer." The explicit nos are as valuable as the yeses.
- **Deliberate deviations from the obvious path.** "Hand-rolled arg parser instead of Commander, because X." Anything where a reasonable reader would assume the opposite.
- **Constraints not visible in the code.** Performance budgets, compliance, partner contracts.
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it, otherwise someone will suggest GraphQL again in six months.
