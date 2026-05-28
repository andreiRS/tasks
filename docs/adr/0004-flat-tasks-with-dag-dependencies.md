# Flat Tasks with DAG Dependencies, no subtasks

The Task model is flat. A complex unit of work is expressed as multiple Tasks linked by Dependencies, never as nested Subtasks. Dependencies form a directed acyclic graph; the Validator rejects any write that would introduce a cycle. Chosen over a tree because trees imply rollup semantics (parent done when children done, parent status from children) that are hard to define consistently and harder for agents to reason about, while a flat DAG keeps every node a first-class Task with the same lifecycle as any other.

## Consequences

- "Breaking down" a Task is a workflow built on `link`/`new`, not a structural operation.
- Hierarchical reporting (progress on a parent) is not directly available; the equivalent question is "which Tasks block Task X" answered via the reverse-dep traversal.
