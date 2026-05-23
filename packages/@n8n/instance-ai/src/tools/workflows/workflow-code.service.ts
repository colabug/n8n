import { hasPlaceholderDeep } from '@n8n/utils';
import { generateWorkflowCode, type WorkflowJSON } from '@n8n/workflow-sdk';
import { nanoid } from 'nanoid';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { buildCredentialMap, resolveCredentials } from './resolve-credentials';
import { stripStaleCredentialsFromWorkflow } from './setup-workflow.service';
import {
	getReferencedWorkflowIds,
	isMockableTriggerNodeType,
	isTriggerNodeType,
} from './workflow-json-utils';
import type { InstanceAiContext } from '../../types';
import { parseAndValidate, partitionWarnings } from '../../workflow-builder';
import { extractWorkflowCode } from '../../workflow-builder/extract-code';
import { applyPatches } from '../../workflow-builder/patch-code';
import type {
	WorkflowBuildOutcome,
	WorkflowSetupRequirement,
	WorkflowVerificationReadiness,
} from '../../workflow-loop/workflow-loop-state';

const patchSchema = z.object({
	old_str: z.string().describe('Exact string to find in the code'),
	new_str: z.string().describe('Replacement string'),
});

// Coerce JSON-stringified arrays into arrays. The model sometimes sends `patches`
// as a JSON string because the payload contains escaped code. Leave non-strings
// untouched so Zod can validate them normally.
function coercePatches(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

const workflowCodeActionBaseSchema = z.object({
	code: z
		.string()
		.optional()
		.describe('Full TypeScript workflow code using @n8n/workflow-sdk. Required for new workflows.'),
	patches: z
		.preprocess(coercePatches, z.array(patchSchema))
		.optional()
		.describe(
			'Array of {old_str, new_str} replacements to apply to existing workflow code. ' +
				'Requires workflowId. More efficient than resending full code for small fixes.',
		),
	workflowId: z.string().optional().describe('ID of the workflow'),
	projectId: z.string().optional().describe('Project ID'),
	name: z.string().optional().describe('Name'),
});

export const workflowCodeCreateActionSchema = workflowCodeActionBaseSchema
	.extend({
		action: z
			.literal('create')
			.describe(
				'Create a workflow from TypeScript SDK code. Use after loading the workflow-builder skill.',
			),
		workflowId: z.undefined().optional(),
	})
	.strict();

export const workflowCodeUpdateActionSchema = workflowCodeActionBaseSchema
	.extend({
		action: z
			.literal('update')
			.describe(
				'Update an existing workflow from TypeScript SDK code or targeted patches. Use after loading the workflow-builder skill.',
			),
		workflowId: z.string().describe('ID of the workflow'),
	})
	.strict();

const confirmationSuspendSchema = z.object({
	requestId: z.string(),
	message: z.string(),
	severity: z.enum(['info', 'warning', 'destructive']),
});

const confirmationResumeSchema = z.object({
	approved: z.boolean(),
});

export type WorkflowCodeCreateInput = z.infer<typeof workflowCodeCreateActionSchema>;
export type WorkflowCodeUpdateInput = z.infer<typeof workflowCodeUpdateActionSchema>;
type WorkflowCodeActionInput = WorkflowCodeCreateInput | WorkflowCodeUpdateInput;
type ResumeData = z.infer<typeof confirmationResumeSchema>;
type WorkflowCodeDeniedResult = { success: false; denied: true; reason: string };

const WEBHOOK_NODE_TYPES = new Set([
	'n8n-nodes-base.webhook',
	'n8n-nodes-base.formTrigger',
	'@n8n/n8n-nodes-langchain.mcpTrigger',
	'@n8n/n8n-nodes-langchain.chatTrigger',
]);

export interface WorkflowCodeToolContext {
	resumeData?: ResumeData;
	suspend: (payload: z.infer<typeof confirmationSuspendSchema>) => Promise<never>;
}

async function ensureWebhookIds(
	json: WorkflowJSON,
	workflowId: string | undefined,
	ctx: InstanceAiContext,
): Promise<void> {
	const existingWebhookIds = new Map<string, string>();
	if (workflowId) {
		try {
			const existing = await ctx.workflowService.getAsWorkflowJSON(workflowId);
			for (const node of existing.nodes ?? []) {
				if (node.webhookId && node.name) {
					existingWebhookIds.set(node.name, node.webhookId);
				}
			}
		} catch {
			// If the existing workflow cannot be fetched, generate fresh ids below.
		}
	}

	for (const node of json.nodes ?? []) {
		if (WEBHOOK_NODE_TYPES.has(node.type) && !node.webhookId) {
			node.webhookId = (node.name && existingWebhookIds.get(node.name)) ?? randomUUID();
		}
	}
}

function getWorkflowId(input: WorkflowCodeActionInput): string | undefined {
	return input.action === 'update' ? input.workflowId : undefined;
}

function approvalLabel(input: WorkflowCodeActionInput): string {
	const name = input.name?.trim();
	const workflowId = getWorkflowId(input);
	if (workflowId) {
		return name ? `Update workflow ${name} (ID: ${workflowId})` : `Update workflow ${workflowId}`;
	}
	return name ? `Create workflow ${name}` : 'Create workflow';
}

function blockSaveIfNeeded(
	context: InstanceAiContext,
	input: WorkflowCodeActionInput,
): WorkflowCodeDeniedResult | undefined {
	const permKey = input.action === 'update' ? 'updateWorkflow' : 'createWorkflow';
	if (context.permissions?.[permKey] === 'blocked') {
		return { success: false, denied: true, reason: 'Action blocked by admin' };
	}

	return undefined;
}

function isSaveAlwaysAllowed(context: InstanceAiContext, input: WorkflowCodeActionInput): boolean {
	if (input.action === 'create') {
		return context.permissions?.createWorkflow === 'always_allow';
	}

	if (context.permissions?.updateWorkflow !== 'always_allow') return false;
	const workflowId = getWorkflowId(input);
	const allowList = context.allowedUpdateWorkflowIds;
	return allowList === undefined || (workflowId !== undefined && allowList.has(workflowId));
}

async function confirmSave(
	context: InstanceAiContext,
	input: WorkflowCodeActionInput,
	ctx: WorkflowCodeToolContext,
): Promise<WorkflowCodeDeniedResult | undefined> {
	const needsApproval = !isSaveAlwaysAllowed(context, input);
	const resumeData = ctx.resumeData;

	if (needsApproval && (resumeData === undefined || resumeData === null)) {
		return await ctx.suspend({
			requestId: nanoid(),
			message: approvalLabel(input),
			severity: 'info',
		});
	}

	if (resumeData !== undefined && resumeData !== null && !resumeData.approved) {
		return { success: false, denied: true, reason: 'User denied the action' };
	}

	return undefined;
}

function hasMockedCredentials(
	outcome: Pick<WorkflowBuildOutcome, 'mockedCredentialTypes' | 'mockedCredentialsByNode'>,
): boolean {
	return (
		(outcome.mockedCredentialTypes?.length ?? 0) > 0 ||
		Object.keys(outcome.mockedCredentialsByNode ?? {}).length > 0
	);
}

function hasCredentialVerificationData(
	outcome: Pick<WorkflowBuildOutcome, 'verificationPinData' | 'usesWorkflowPinDataForVerification'>,
): boolean {
	return (
		Object.keys(outcome.verificationPinData ?? {}).length > 0 ||
		outcome.usesWorkflowPinDataForVerification === true
	);
}

function determineDirectVerificationReadiness(
	outcome: Pick<
		WorkflowBuildOutcome,
		| 'submitted'
		| 'workflowId'
		| 'triggerNodes'
		| 'mockedCredentialTypes'
		| 'mockedCredentialsByNode'
		| 'verificationPinData'
		| 'usesWorkflowPinDataForVerification'
		| 'hasUnresolvedPlaceholders'
	>,
): WorkflowVerificationReadiness {
	if (!outcome.submitted) {
		return {
			status: 'not_verifiable',
			reason: 'not-submitted',
			guidance: 'The build did not submit a workflow, so there is nothing to verify.',
		};
	}

	if (!outcome.workflowId) {
		return {
			status: 'not_verifiable',
			reason: 'missing-workflow-id',
			guidance: 'The build outcome does not include a workflow ID.',
		};
	}

	if (outcome.hasUnresolvedPlaceholders) {
		return {
			status: 'needs_setup',
			reason: 'unresolved-placeholders',
			guidance: 'Route the workflow through setup before verification.',
		};
	}

	if (hasMockedCredentials(outcome) && !hasCredentialVerificationData(outcome)) {
		return {
			status: 'needs_setup',
			reason: 'missing-mocked-credential-pin-data',
			guidance: 'Route the workflow through setup because mocked credentials cannot be verified.',
		};
	}

	if (!outcome.triggerNodes?.some((node) => isMockableTriggerNodeType(node.nodeType))) {
		return {
			status: 'not_verifiable',
			reason: 'non-mockable-trigger',
			guidance: 'The workflow does not have a trigger the post-build verifier can exercise.',
		};
	}

	return { status: 'ready' };
}

function determineDirectSetupRequirement(
	outcome: Pick<
		WorkflowBuildOutcome,
		| 'submitted'
		| 'workflowId'
		| 'mockedCredentialTypes'
		| 'mockedCredentialsByNode'
		| 'hasUnresolvedPlaceholders'
	>,
): WorkflowSetupRequirement {
	if (!outcome.submitted || !outcome.workflowId) {
		return { status: 'not_required' };
	}

	if (outcome.hasUnresolvedPlaceholders) {
		return {
			status: 'required',
			reason: 'unresolved-placeholders',
			guidance: 'Route the workflow through setup so the user can fill unresolved values.',
		};
	}

	if (hasMockedCredentials(outcome)) {
		return {
			status: 'required',
			reason: 'mocked-credentials',
			guidance: 'Route the workflow through setup so the user can add real credentials.',
		};
	}

	return { status: 'not_required' };
}

async function reportPlannedBuildSuccess({
	context,
	workflowId,
	workflowName,
	triggerNodes,
	mockedNodeNames,
	mockedCredentialTypes,
	mockedCredentialsByNode,
	verificationPinData,
	usesWorkflowPinDataForVerification,
	supportingWorkflowIds,
	hasUnresolvedPlaceholders,
}: {
	context: InstanceAiContext;
	workflowId: string;
	workflowName?: string;
	triggerNodes: Array<{ nodeName: string; nodeType: string }>;
	mockedNodeNames?: string[];
	mockedCredentialTypes?: string[];
	mockedCredentialsByNode?: Record<string, string[]>;
	verificationPinData?: Record<string, Array<Record<string, unknown>>>;
	usesWorkflowPinDataForVerification?: boolean;
	supportingWorkflowIds?: string[];
	hasUnresolvedPlaceholders?: boolean;
}): Promise<void> {
	const plannedBuildTask = context.plannedBuildTask;
	if (!plannedBuildTask) return;

	const summary = workflowName
		? `Workflow built: ${workflowName}.`
		: `Workflow built: ${workflowId}.`;
	const hasMockedNodeNames = (mockedNodeNames?.length ?? 0) > 0;
	const hasMockedCredentialTypes = (mockedCredentialTypes?.length ?? 0) > 0;
	const hasMockedCredentialsByNode = Object.keys(mockedCredentialsByNode ?? {}).length > 0;
	const hasVerificationPinData = Object.keys(verificationPinData ?? {}).length > 0;
	const outcomeWithoutRouting: Omit<
		WorkflowBuildOutcome,
		'verificationReadiness' | 'setupRequirement'
	> = {
		workItemId: plannedBuildTask.workItemId,
		...(context.runId ? { runId: context.runId } : {}),
		taskId: plannedBuildTask.taskId,
		workflowId,
		submitted: true,
		triggerType: 'manual_or_testable',
		triggerNodes,
		needsUserInput: Boolean(
			hasUnresolvedPlaceholders === true || hasMockedCredentialTypes || hasMockedCredentialsByNode,
		),
		...(hasMockedNodeNames ? { mockedNodeNames } : {}),
		...(hasMockedCredentialTypes ? { mockedCredentialTypes } : {}),
		...(hasMockedCredentialsByNode ? { mockedCredentialsByNode } : {}),
		...(hasVerificationPinData ? { verificationPinData } : {}),
		...(usesWorkflowPinDataForVerification ? { usesWorkflowPinDataForVerification } : {}),
		...(supportingWorkflowIds && supportingWorkflowIds.length > 0 ? { supportingWorkflowIds } : {}),
		...(hasUnresolvedPlaceholders !== undefined ? { hasUnresolvedPlaceholders } : {}),
		summary,
	};
	const outcome: WorkflowBuildOutcome = {
		...outcomeWithoutRouting,
		verificationReadiness: determineDirectVerificationReadiness(outcomeWithoutRouting),
		setupRequirement: determineDirectSetupRequirement(outcomeWithoutRouting),
	};

	await plannedBuildTask.workflowTaskService?.reportBuildOutcome(outcome);
	await plannedBuildTask.plannedTaskService.markSucceeded(
		plannedBuildTask.threadId,
		plannedBuildTask.taskId,
		{
			result: summary,
			outcome,
		},
	);
}

async function reportPlannedBuildSuccessSafely(
	input: Parameters<typeof reportPlannedBuildSuccess>[0],
): Promise<string | undefined> {
	try {
		await reportPlannedBuildSuccess(input);
		return undefined;
	} catch (error) {
		input.context.logger?.warn?.('Failed to report planned build success', {
			error: error instanceof Error ? error.message : String(error),
		});
		return error instanceof Error ? error.message : String(error);
	}
}

export function createWorkflowCodeService(context: InstanceAiContext) {
	// Keeps the last code submitted (or patched) so patches work even before save,
	// and always match the LLM's own code — not a roundtripped version.
	let lastCode: string | null = null;

	async function saveWorkflowCode(input: WorkflowCodeActionInput, ctx: WorkflowCodeToolContext) {
		const blocked = blockSaveIfNeeded(context, input);
		if (blocked) return blocked;

		const { code, patches, projectId, name } = input;
		const workflowId = getWorkflowId(input);
		let finalCode: string;

		if (patches) {
			// Patch mode: apply str_replace to existing code.
			// Source priority: lastCode (same session) → fetch from backend (cross-session)
			let baseCode = lastCode;
			if (!baseCode && workflowId) {
				try {
					const json = await context.workflowService.getAsWorkflowJSON(workflowId);
					baseCode = generateWorkflowCode(json);
					lastCode = baseCode; // Sync so future patches match this code
				} catch {
					return {
						success: false,
						errors: [
							'Patch mode: no previous code and could not fetch workflow. Send full code instead.',
						],
					};
				}
			}
			if (!baseCode) {
				return {
					success: false,
					errors: [
						'Patch mode requires either previous workflow code in this turn or a workflowId to fetch from.',
					],
				};
			}

			const patchResult = applyPatches(baseCode, patches);
			if (!patchResult.success) {
				return { success: false, errors: [patchResult.error] };
			}

			finalCode = patchResult.code;
		} else if (code) {
			finalCode = extractWorkflowCode(code);
		} else {
			return {
				success: false,
				errors: ['Either `code` (full code) or `patches` (to fix previous code) is required.'],
			};
		}

		// Parse TypeScript to WorkflowJSON with two-stage validation
		let result;
		try {
			result = parseAndValidate(finalCode, {
				nodeTypesProvider: context.nodeTypesProvider,
			});
		} catch (error) {
			lastCode = finalCode;
			return {
				success: false,
				errors: [error instanceof Error ? error.message : 'Failed to parse workflow code'],
			};
		}

		// Partition validation results into blocking errors and informational warnings
		const { errors, informational } = partitionWarnings(result.warnings);

		if (errors.length > 0) {
			lastCode = finalCode;
			return {
				success: false,
				errors: errors.map(
					(e) => `[${e.code}]${e.nodeName ? ` (${e.nodeName})` : ''}: ${e.message}`,
				),
				warnings:
					informational.length > 0
						? informational.map((w) => `[${w.code}]: ${w.message}`)
						: undefined,
			};
		}

		const json = result.workflow;
		if (name) {
			json.name = name;
		} else if (!json.name && !workflowId) {
			return {
				success: false,
				errors: [
					'Workflow name is required for new workflows. Provide a name parameter or set it in the SDK code.',
				],
			};
		}

		// Resolve undefined/null credentials before saving.
		// newCredential() produces NewCredentialImpl which serializes to undefined.
		const credentialMap = await buildCredentialMap(context.credentialService);
		const mockResult = await resolveCredentials(json, workflowId, context, credentialMap);

		// Strip credential entries that are no longer valid for the current
		// parameters. Resolution above (and the LLM itself) can re-emit stale
		// references between turns; without this, setup analysis would surface
		// a credential request for a node that no longer needs one.
		await stripStaleCredentialsFromWorkflow(context, json);

		// Ensure webhook nodes have a webhookId so n8n registers clean paths
		await ensureWebhookIds(json, workflowId, context);
		const triggerNodes = (json.nodes ?? [])
			.filter((n) => isTriggerNodeType(n.type))
			.map((n) => ({ nodeName: n.name, nodeType: n.type }))
			.filter(
				(t): t is { nodeName: string; nodeType: string } =>
					Boolean(t.nodeName) && Boolean(t.nodeType),
			);
		const hasPlaceholders =
			(json.nodes ?? []).some((n) => hasPlaceholderDeep(n.parameters)) || undefined;
		const referencedWorkflowIds = getReferencedWorkflowIds(json);
		const hasMocked = mockResult.mockedNodeNames.length > 0;

		try {
			const confirmationInput: WorkflowCodeActionInput = {
				...input,
				name: input.name ?? json.name,
			};
			const denied = await confirmSave(context, confirmationInput, ctx);
			if (denied) return denied;

			// Remember only after approval. Patch-mode handlers are re-entered on HITL
			// resume with the original input, so caching a valid pre-approval patch
			// would make the resumed call apply the same patch twice.
			lastCode = finalCode;

			if (workflowId) {
				const updated = await context.workflowService.updateFromWorkflowJSON(
					workflowId,
					json,
					projectId ? { projectId } : undefined,
				);
				const plannedReportError = await reportPlannedBuildSuccessSafely({
					context,
					workflowId: updated.id,
					workflowName: json.name,
					triggerNodes,
					mockedNodeNames: hasMocked ? mockResult.mockedNodeNames : undefined,
					mockedCredentialTypes: hasMocked ? mockResult.mockedCredentialTypes : undefined,
					mockedCredentialsByNode: hasMocked ? mockResult.mockedCredentialsByNode : undefined,
					verificationPinData:
						hasMocked && Object.keys(mockResult.verificationPinData).length > 0
							? mockResult.verificationPinData
							: undefined,
					usesWorkflowPinDataForVerification:
						mockResult.usesWorkflowPinDataForVerification || undefined,
					supportingWorkflowIds:
						referencedWorkflowIds.length > 0 ? referencedWorkflowIds : undefined,
					hasUnresolvedPlaceholders: hasPlaceholders,
				});
				if (plannedReportError) {
					return {
						success: false,
						workflowId: updated.id,
						workflowName: json.name,
						errors: [
							`Workflow was saved, but failed to update planned task state: ${plannedReportError}`,
						],
					};
				}
				return {
					success: true,
					workflowId: updated.id,
					workflowName: json.name,
					warnings:
						informational.length > 0
							? informational.map((w) => `[${w.code}]: ${w.message}`)
							: undefined,
				};
			} else {
				const created = await context.workflowService.createFromWorkflowJSON(json, {
					...(projectId ? { projectId } : {}),
					markAsAiTemporary: true,
				});
				(context.aiCreatedWorkflowIds ??= new Set<string>()).add(created.id);
				const plannedReportError = await reportPlannedBuildSuccessSafely({
					context,
					workflowId: created.id,
					workflowName: json.name,
					triggerNodes,
					mockedNodeNames: hasMocked ? mockResult.mockedNodeNames : undefined,
					mockedCredentialTypes: hasMocked ? mockResult.mockedCredentialTypes : undefined,
					mockedCredentialsByNode: hasMocked ? mockResult.mockedCredentialsByNode : undefined,
					verificationPinData:
						hasMocked && Object.keys(mockResult.verificationPinData).length > 0
							? mockResult.verificationPinData
							: undefined,
					usesWorkflowPinDataForVerification:
						mockResult.usesWorkflowPinDataForVerification || undefined,
					supportingWorkflowIds:
						referencedWorkflowIds.length > 0 ? referencedWorkflowIds : undefined,
					hasUnresolvedPlaceholders: hasPlaceholders,
				});
				if (plannedReportError) {
					return {
						success: false,
						workflowId: created.id,
						workflowName: json.name,
						errors: [
							`Workflow was saved, but failed to update planned task state: ${plannedReportError}`,
						],
					};
				}
				return {
					success: true,
					workflowId: created.id,
					workflowName: json.name,
					warnings:
						informational.length > 0
							? informational.map((w) => `[${w.code}]: ${w.message}`)
							: undefined,
				};
			}
		} catch (error) {
			return {
				success: false,
				errors: [
					`Workflow save failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
				],
			};
		}
	}

	return {
		create: async (input: WorkflowCodeCreateInput, ctx: WorkflowCodeToolContext) =>
			await saveWorkflowCode(input, ctx),
		update: async (input: WorkflowCodeUpdateInput, ctx: WorkflowCodeToolContext) =>
			await saveWorkflowCode(input, ctx),
	};
}
