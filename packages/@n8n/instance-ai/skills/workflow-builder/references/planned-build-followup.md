# Planned Build Follow-Up

Use this reference only when the current input contains
`<planned-task-follow-up type="build-workflow">`.

## Source Of Truth

The `buildTask` payload is authoritative. It contains the task `id`, `title`,
`spec`, optional `workflowId`, and `workItemId`. Build exactly that task and do
not create a new plan.

## Procedure

1. Read the `buildTask.spec`, dependency outcomes, and any existing
   `workflowId`.
2. Load [sdk-rules.md](sdk-rules.md) before writing SDK code. Load
   [branch-tracing.md](branch-tracing.md) for branches, merges, agents, data
   shape, or helper-workflow wiring.
3. Call `workflows(action="create")` for a planned create or
   `workflows(action="update")` for a planned update.
4. If validation errors return, patch and retry in the same turn.
5. Stop after the successful create/update call. The tool records the planned
   task outcome for later checkpoint verification.

Do not call `complete-checkpoint`, do not write a user-facing completion
message, and do not perform verification from the build follow-up turn. Later
checkpoint follow-ups use [build-lifecycle.md](build-lifecycle.md) for verify,
patch, setup, and completion.
