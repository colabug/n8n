# Build Lifecycle

The canonical workflow-building lifecycle is: save the workflow, verify it with
structured evidence, patch and re-verify if needed, then route setup only after
verification succeeds. Route setup before verification only when the build
outcome explicitly says setup is required before verification can run.

## Save

- Save with `workflows(action="create"|"update")`. Validation success proves the
  graph can be saved; it does not prove the workflow works.
- Only set `temporary: true` on `workflows(action="create")` for scratch or
  intermediate drafts that should be archived automatically. Omit it for final
  user-visible workflows, including approved helper workflows.
- If `workflows(action="create"|"update")` returns validation errors, patch and
  retry in the same turn.

## Verification Routing

Use the saved build outcome as the routing source:

- If `outcome.verificationReadiness.status === "already_verified"`, treat the
  workflow as verified and do not call `verify-built-workflow` again.
- If `outcome.verificationReadiness.status === "ready"`, verify with
  `verify-built-workflow` using `outcome.workItemId`, `outcome.workflowId`, and
  trigger-appropriate `inputData`. If `verify-built-workflow` is not available
  in this host, use `executions(action="run")` when the workflow has real
  credentials and a testable trigger; otherwise explain the blocker.
- If `outcome.verificationReadiness.status === "needs_setup"`, call
  `workflows(action="setup")` so the user can configure the workflow through the
  inline setup card in the AI Assistant panel.
- If `outcome.verificationReadiness.status === "not_verifiable"`, use its
  guidance to decide whether to explain the blocker or ask the user to test
  manually.

`verify-built-workflow` and `executions(action="run")` work without publishing.

## Per-Trigger inputData Shape

The pin-data adapter spreads or wraps based on trigger type. Passing the wrong
shape creates null downstream values that look like expression bugs:

- Form Trigger (`n8n-nodes-base.formTrigger`): pass a flat field map, for
  example `{name: "Alice", email: "a@b.c"}`. Do not wrap in `formFields`.
- Webhook (`n8n-nodes-base.webhook`): pass the body payload, for example
  `{event: "signup", userId: "..."}`. The adapter wraps it under `body`.
- Chat Trigger (`@n8n/n8n-nodes-langchain.chatTrigger`): pass
  `{chatInput: "user message"}`.
- Schedule Trigger (`n8n-nodes-base.scheduleTrigger`): omit `inputData`; the
  adapter emits synthetic timestamp fields.

Do not patch a workflow first when verification returns null downstream values.
Re-run verification with the corrected `inputData` shape. Patch only if the
expression is wrong against the production trigger output shape.

## Patch And Setup

- If verification exposes a workflow bug that can be patched narrowly, call
  `workflows(action="update")`, then verify again.
- Keep patch attempts bounded. If the issue cannot be narrowed within two
  rounds, report the concrete blocker.
- If the verified workflow still has mocked credentials or placeholders, call
  `workflows(action="setup")`.
- When `workflows(action="setup")` opens the inline setup card, that card is the
  user-visible surface. Do not tell the user to open the editor, use the canvas,
  or click a Setup button.
- If setup returns `deferred: true`, respect the user's decision and do not
  retry with `credentials(action="setup")` or other setup tools.

## Publish

Publish only when the user explicitly asks. Publishing is not required for
`verify-built-workflow` or `executions(action="run")`.
