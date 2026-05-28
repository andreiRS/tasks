# Attendance enum + Effort enum, replacing the agent_ready / human_in_loop booleans

Pickup eligibility is encoded as a single `attendance: attended | unattended` enum, not as two booleans (`agent_ready`, `human_in_loop`). A separate `effort: low | medium | high` enum captures the expected cognitive or model resource needed to pick the Task up; in v1 it is pure metadata that the CLI stores, surfaces, and filters on but never acts on. Chosen over the two-boolean design because the booleans had a contradictory state (`agent_ready: true` *and* `human_in_loop: true`) the validator would have had to reject anyway, and because splitting "who picks this up" from "how heavy is it" leaves room for orchestration to read both without conflating the axes.

## Consequences

- `tasks next` no longer hard-filters on `agent_ready: true`; humans see the oldest ready Task by default, agents pass `--unattended` to opt into the agent-pickup gate.
- `tasks new` writes both fields with their defaults (`attended`, `medium`) so Task files are self-describing in `$EDITOR`; older files without the keys resolve to defaults on read.
- New error codes are added to the envelope: `INVALID_ATTENDANCE`, `INVALID_EFFORT`.
- `effort` is a contract the CLI must keep writing and accepting, even though no v1 command branches on it. Orchestration loops outside `tasks` are free to interpret it.
