---
name: workflow-builder
description: >-
  Builds and edits n8n workflows directly with the workflow SDK and the
  workflows tool. Use for existing-workflow edits, fixes, node rewiring,
  credential-preserving patches, verification, setup routing, and workflow
  creation only inside approved planned build follow-up turns.
recommended_tools:
  - workflows
  - verify-built-workflow
  - executions
  - credentials
  - nodes
  - data-tables
  - parse-file
  - ask-user
platforms:
  - daytona
---

# Workflow Builder

Use this skill to patch, fix, verify, set up, and update existing n8n workflows
in normal user-facing turns. Use it for new workflow creation only when the
current input is an approved `<planned-task-follow-up type="build-workflow">`.
For a normal user request to build a brand-new workflow, do not load this skill
first; call `plan` so the planned-task scheduler can create the build and
checkpoint follow-ups. Do not delegate workflow-building work or call legacy
workflow-building tools.

## Default Procedure

1. Classify the request: planned new-workflow build follow-up, edit existing
   workflow, patch after an error, credential/resource setup, or verification
   follow-up. If this is a normal user-facing new workflow request without a
   `<planned-task-follow-up type="build-workflow">`, stop using this skill and
   call `plan`.
2. Inspect existing state before editing. Use `workflows(action="get-as-code")`
   when a `workflowId` is available and patches need exact source strings.
3. Discover node schemas before configuring nodes. Use
   `nodes(action="suggested")` for known workflow categories and
   `nodes(action="search")` plus `nodes(action="type-definition")` for
   integration-specific nodes. Treat `@builderHint` annotations as the source
   of truth.
4. Check credentials with `credentials(action="list")`. Preserve explicit
   user-selected credentials. If one matching credential exists, wire it. If
   multiple matching credentials exist and the user did not name one, ask once.
5. Generate TypeScript SDK code using `@n8n/workflow-sdk`, then call
   `workflows(action="create")` only for approved planned build follow-ups or
   `workflows(action="update", workflowId, ...)` for existing workflows. For
   small fixes, prefer `patches` over resending the full workflow code.
   Only set `temporary: true` on `workflows(action="create")` for scratch or
   intermediate drafts that should be archived automatically; omit it for final
   user-visible workflows, including approved helper workflows.
6. If `workflows(action="create"|"update")` returns validation errors, patch and
   retry in the same turn. Stop only after a successful save or a concrete
   blocker.
7. If a mutating tool returns `denied: true`, stop immediately. Do not retry the
   mutation in the same turn; tell the user no changes were made.

## Builder Discipline

This skill replaces the old detached workflow-builder agent. Keep the same
discipline even though you are using native workflow tools directly:

- Research first: use suggested/search/type-definition tools and treat
  `@builderHint` annotations as current node documentation.
- Build complete SDK code, not fragments. The first save should be a real
  workflow draft with all requested triggers, actions, branches, and setup
  placeholders connected.
- Trace the graph before saving. For IF, Switch, and Merge nodes, follow every
  branch from producer to consumer and confirm outputs are wired by the SDK's
  branch helpers, not by visual intuition.
- Trace data shape, not just node existence. If a node formats `subject`,
  `message`, `rows`, or similar fields, make sure the downstream sender/writer
  receives that exact item shape on the same branch.
- Patch from tool evidence. Use validation errors, build outcomes, execution
  evidence, and verifier findings as the repair source; do not patch from a
  vague guess when the evidence points to an input-shape or setup issue.

## Build Lifecycle

The canonical workflow-building lifecycle is: save the workflow, verify it with
structured evidence, patch and re-verify if needed, then run setup only after
verification succeeds. Only route setup before verification when the build
outcome explicitly reports setup is required before verification can run.

- Save with `workflows(action="create"|"update")`. Validation success proves the
  graph can be saved; it is not enough to call the workflow done.
- Verify with tool evidence, not builder prose. Prefer `verify-built-workflow`
  with the workflow build outcome's `workItemId`; use `executions(action="run")`
  when the workflow has real credentials and a testable trigger. Pass
  trigger-appropriate `inputData`.
- If verification exposes a workflow bug that can be patched narrowly, call
  `workflows(action="update")`, then verify again. Keep patch attempts bounded;
  report a concrete blocker when the issue cannot be narrowed.
- If the verified workflow still has mocked credentials or placeholders, call
  `workflows(action="setup")` after verification. The inline setup card is the
  user-visible surface; do not ask the user to open the editor or run separate
  credential setup tools.
- If setup returns `deferred: true`, respect the user's decision and do not
  retry with `credentials(action="setup")` or other setup tools.
- Publish only when the user explicitly asks. Publishing is not required for
  `verify-built-workflow` or `executions(action="run")`.

In planned build follow-up turns, only perform the save phase and stop. The later
verification follow-up must apply the verify, patch, and setup phases above.

## Modular Workflows

For complex systems, prefer the approved plan's decomposition over inventing a
large single workflow. If the plan contains helper workflow tasks followed by a
main workflow task:

- Build helper workflows as callable sub-workflows with a strict input contract
  and a clear returned output shape.
- Use an `executeWorkflowTrigger` node for each helper workflow's entry point.
- When building the main workflow, read dependency outcomes from the
  `<planned-task-follow-up>` task list and reference each helper by its
  `outcome.workflowId` in `executeWorkflow` nodes.
- Keep simple workflows as one workflow. Do not create extra workflows unless
  the approved plan or the user's request calls for modular composition.

## SDK Rules

- Do not use web search to learn workflow SDK syntax. Use this skill, node
  type definitions, and `workflows(action="create"|"update")` validation errors.
- Always import the SDK factories directly:
  `workflow`, `node`, `trigger`, `sticky`, `placeholder`, `newCredential`,
  `ifElse`, `switchCase`, `merge`, `splitInBatches`, `nextBatch`,
  `languageModel`, `memory`, `tool`, `outputParser`, `embedding`,
  `embeddings`, `vectorStore`, `retriever`, `documentLoader`, `textSplitter`,
  `fromAi`, and `expr`.
- Do not specify node positions. The layout engine handles positions.
- Use `expr('{{ $json.field }}')` for n8n expressions. Variables must be inside
  `{{ }}`.
- Do not use TypeScript-only syntax that the workflow parser cannot consume,
  especially `as const`.
- Use string literals directly for discriminator fields such as `resource` and
  `operation`.
- Use `workflow('local-id', 'Workflow Name').add(startTrigger).to(nextNode)`.
  Do not use `new WorkflowBuilder()`, `workflow([...])`, `connect(...)`, or
  helper factories like `manualTrigger()` or `set()`.
- When editing round-tripped workflow code, remove `position` arrays and replace
  raw credential objects with `newCredential(...)`.
- Use `newCredential('Name', 'id')` only for an explicit existing credential.
  Use `newCredential('Suggested Name')` when no exact credential is selected;
  `workflows(action="create"|"update")` will preserve valid credentials and
  mock unresolved ones.
- Never invent credential IDs, API tokens, resource IDs, Slack channels,
  Telegram chat IDs, email addresses, bearer tokens, or sample user data.
  Use `placeholder()` for user-provided values that must be collected later.
- The credential-selection guidance above applies to outbound service calls. For
  inbound triggers such as Webhook or Form Trigger, keep authentication at its
  default `none` unless the user explicitly asks to authenticate inbound traffic.
- Resource IDs with more than one candidate: If `explore-resources` returns more
  than one match and the user did not name a specific one, use
  `placeholder('Select <resource>')`.

## Core SDK Pattern

For a linear workflow, define nodes first, then compose with `.add(...).to(...)`:

```typescript
import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const startTrigger = trigger({
	type: 'n8n-nodes-base.manualTrigger',
	version: 1,
	config: { name: 'Manual Trigger' },
});

const setFields = node({
	type: 'n8n-nodes-base.set',
	version: 3.4,
	config: {
		name: 'Set Fields',
		parameters: {
			mode: 'manual',
			assignments: {
				assignments: [
					{
						id: 'message',
						name: 'message',
						value: 'Hello from n8n',
						type: 'string',
					},
				],
			},
		},
	},
});

export default workflow('example-workflow', 'Example Workflow').add(startTrigger).to(setFields);
```

For branches, use SDK connection methods: IF uses `.onTrue()` / `.onFalse()`,
Switch uses `.onCase(index, target)`, Merge inputs use `.input(0)`,
`.input(1)`, and linear chains use `.to(nextNode)`.

## Node Configuration Safety Rules

- Fetch `nodes(action="type-definition")` before configuring nodes. Generated
  definitions and `@builderHint` annotations are the source of truth.
- Use live `nodes(action="explore-resources")` for resource locator, list, and
  model fields when credentials are available.
- If a configuration is unclear after reading the definition, ask for
  clarification or use placeholders. Do not guess.

## Workflow Design Rules

- Describe and implement the user's goal, integrations, data flow, and table
  requirements. Do not overfit to guessed node parameter names.
- Parameter precedence is: user value > live resource/tool result >
  node `@builderHint` / default. If the user gave a concrete value, preserve it.
  Otherwise resolve it with tools or leave it as a placeholder.
- For IF, Switch, and Merge nodes, trace every branch before declaring success.
  Confirm IF outputs use `.onTrue()` / `.onFalse()`, Switch outputs use
  zero-based `.onCase(index, target)`, and Merge mode matches the data shape.
- For empty item lists, let the workflow emit zero items. Do not add
  `alwaysOutputData: true` or redundant IF gates just to keep downstream nodes
  alive.
- Use `executeOnce: true` when one node should run once for many input items,
  such as sending a summary notification or generating a report.
- Pick the right control-flow primitive: `filter` for dropping items, `IF` for
  two real branches, `switch` for many keyed branches, and `splitInBatches` for
  per-item side effects.
- Name AI tools by the action they perform. Set explicit concise snake_case
  tool names such as `get_email`, `add_labels`, or `mark_as_read`.

## Existing Workflow Edits

- Prefer `workflows(action="update")` patch mode for small edits:
  `{ action: "update", workflowId, patches: [{ old_str, new_str }] }`.
- Fetch current code with `workflows(action="get-as-code")` when you need exact
  patch anchors or need to understand existing wiring.
- If patch mode cannot find the anchor, send full SDK code to
  `workflows(action="update")` with the same `workflowId`.
- Do not use `workflows(action="update-json")`; it is reserved for internal
  eval setup flows that must patch raw WorkflowJSON after a separate approval.
- Preserve existing credentials unless the user asks to change them.
- Preserve webhook paths and resource references unless the edit requires a
  change.
- Unresolved credentials and placeholders are handled in the inline setup card in
  the AI Assistant panel after the workflow is saved.

## Planned Build Follow-Ups

When the input contains `<planned-task-follow-up type="build-workflow">`, use
the `buildTask` payload as the source of truth. Load this skill, perform that
one build task, call `workflows(action="create"|"update")`, patch validation
errors if needed, and then stop. The successful tool call records the planned
task outcome for later verification.

## Completion

Stay silent while working unless blocked. On normal user-facing turns, finish
with one concise sentence naming the saved or verified workflow and any setup
status. In planned build follow-up turns, do not write a user-facing completion
message after the successful workflow create/update call.
