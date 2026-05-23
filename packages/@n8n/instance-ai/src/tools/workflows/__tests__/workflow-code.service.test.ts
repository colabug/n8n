import type { InstanceAiContext } from '../../../types';
import type * as WorkflowCodeParserModule from '../../../workflow-builder';
import { parseAndValidate } from '../../../workflow-builder';
import {
	createWorkflowCodeService,
	workflowCodeUpdateActionSchema,
} from '../workflow-code.service';

jest.mock('../../../workflow-builder', () => {
	const actual = jest.requireActual<typeof WorkflowCodeParserModule>('../../../workflow-builder');
	return {
		...actual,
		parseAndValidate: jest.fn(),
	};
});

describe('workflowCodeUpdateActionSchema.patches coercion', () => {
	const patch = { old_str: 'foo', new_str: 'bar' };

	it('accepts a native array of patches', () => {
		const parsed = workflowCodeUpdateActionSchema.parse({
			action: 'update',
			workflowId: 'wf-1',
			patches: [patch],
		});
		expect(parsed.patches).toEqual([patch]);
	});

	it('accepts a JSON-stringified array of patches', () => {
		const parsed = workflowCodeUpdateActionSchema.parse({
			action: 'update',
			workflowId: 'wf-1',
			patches: JSON.stringify([patch]),
		});
		expect(parsed.patches).toEqual([patch]);
	});

	it('rejects a non-JSON string with a helpful array-expected error', () => {
		const result = workflowCodeUpdateActionSchema.safeParse({
			action: 'update',
			workflowId: 'wf-1',
			patches: 'not-json',
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].path).toEqual(['patches']);
		}
	});

	it('rejects a stringified object (not an array)', () => {
		const result = workflowCodeUpdateActionSchema.safeParse({
			action: 'update',
			workflowId: 'wf-1',
			patches: JSON.stringify(patch),
		});
		expect(result.success).toBe(false);
	});

	it('leaves patches undefined when not provided', () => {
		const parsed = workflowCodeUpdateActionSchema.parse({
			action: 'update',
			workflowId: 'wf-1',
		});
		expect(parsed.patches).toBeUndefined();
	});
});

describe('workflow code create/update approval flow', () => {
	type WorkflowCodeService = ReturnType<typeof createWorkflowCodeService>;
	type WorkflowCodeToolContext = Parameters<WorkflowCodeService['create']>[1];
	type Permissions = NonNullable<InstanceAiContext['permissions']>;

	const validCode = "export default workflow('wf-1', 'Lead intake');";
	const validWorkflow = { name: 'Lead intake', nodes: [], connections: {} };
	const mockedParseAndValidate = jest.mocked(parseAndValidate);

	function makeContext(
		permissions: Partial<Permissions>,
		overrides: Partial<InstanceAiContext> = {},
	): InstanceAiContext {
		return {
			userId: 'user-1',
			permissions: permissions as Permissions,
			workflowService: {
				createFromWorkflowJSON: jest.fn().mockResolvedValue({ id: 'created-wf' }),
				updateFromWorkflowJSON: jest.fn().mockResolvedValue({ id: 'wf-1' }),
				getAsWorkflowJSON: jest.fn().mockResolvedValue(validWorkflow),
				clearAiTemporary: jest.fn().mockResolvedValue(undefined),
			},
			executionService: {},
			credentialService: { list: jest.fn().mockResolvedValue([]) },
			nodeService: {},
			dataTableService: {},
			...overrides,
		} as unknown as InstanceAiContext;
	}

	function makeToolContext(resumeData?: { approved: boolean }): {
		context: WorkflowCodeToolContext;
		suspend: jest.Mock;
	} {
		const suspend = jest.fn().mockResolvedValue(undefined);
		return {
			context: { resumeData, suspend } as WorkflowCodeToolContext,
			suspend,
		};
	}

	beforeEach(() => {
		jest.clearAllMocks();
		mockedParseAndValidate.mockReturnValue({
			workflow: { ...validWorkflow },
			warnings: [],
		});
	});

	it('suspends for approval after validating a workflow create', async () => {
		const service = createWorkflowCodeService(makeContext({}));
		const { context, suspend } = makeToolContext();

		await service.create({ action: 'create', code: validCode, name: 'Lead intake' }, context);

		expect(suspend).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Create workflow Lead intake',
				severity: 'info',
			}),
		);
	});

	it('suspends for approval after validating a workflow update', async () => {
		const service = createWorkflowCodeService(makeContext({}));
		const { context, suspend } = makeToolContext();

		await service.update(
			{ action: 'update', code: validCode, workflowId: 'wf-1', name: 'Lead intake' },
			context,
		);

		expect(suspend).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Update workflow Lead intake (ID: wf-1)',
				severity: 'info',
			}),
		);
	});

	it('uses the parsed workflow name in update approval when the input omits name', async () => {
		const service = createWorkflowCodeService(makeContext({}));
		const { context, suspend } = makeToolContext();

		await service.update({ action: 'update', code: validCode, workflowId: 'wf-1' }, context);

		expect(suspend).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Update workflow Lead intake (ID: wf-1)',
				severity: 'info',
			}),
		);
	});

	it('returns a denied result when the user denies approval', async () => {
		const service = createWorkflowCodeService(makeContext({}));
		const { context } = makeToolContext({ approved: false });

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake' },
			context,
		);

		expect(result).toEqual({ success: false, denied: true, reason: 'User denied the action' });
	});

	it('returns a blocked result when admin policy blocks the save', async () => {
		const service = createWorkflowCodeService(makeContext({ createWorkflow: 'blocked' }));
		const { context } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: 'invalid', name: 'Lead intake' },
			context,
		);

		expect(result).toEqual({ success: false, denied: true, reason: 'Action blocked by admin' });
	});

	it('does not suspend or save when validation fails', async () => {
		mockedParseAndValidate.mockImplementationOnce(() => {
			throw new Error('Failed to parse workflow code: syntax error');
		});
		const ctx = makeContext({});
		const service = createWorkflowCodeService(ctx);
		const { context, suspend } = makeToolContext();

		await service.create({ action: 'create', code: 'invalid', name: 'Lead intake' }, context);

		expect(suspend).not.toHaveBeenCalled();
		expect(ctx.workflowService.createFromWorkflowJSON).not.toHaveBeenCalled();
	});

	it('does not suspend when the save is always allowed', async () => {
		const ctx = makeContext({ createWorkflow: 'always_allow' });
		const service = createWorkflowCodeService(ctx);
		const { context, suspend } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake' },
			context,
		);

		expect(suspend).not.toHaveBeenCalled();
		expect(ctx.workflowService.createFromWorkflowJSON).toHaveBeenCalled();
		expect(ctx.workflowService.clearAiTemporary).toHaveBeenCalledWith('created-wf');
		expect(ctx.aiCreatedWorkflowIds?.has('created-wf')).toBe(false);
		expect(result).toMatchObject({
			success: true,
			workflowId: 'created-wf',
			workflowName: 'Lead intake',
		});
	});

	it('returns direct save routing metadata for setup and verification', async () => {
		mockedParseAndValidate.mockReturnValueOnce({
			workflow: {
				name: 'Lead intake',
				nodes: [
					{
						name: 'Webhook',
						type: 'n8n-nodes-base.webhook',
						typeVersion: 2,
						parameters: { path: '<__PLACEHOLDER_VALUE__webhook-path__>' },
					},
				],
				connections: {},
			},
			warnings: [],
		});
		const ctx = makeContext({ createWorkflow: 'always_allow' });
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake' },
			context,
		);

		expect(result).toMatchObject({
			success: true,
			workflowId: 'created-wf',
			triggerNodes: [{ nodeName: 'Webhook', nodeType: 'n8n-nodes-base.webhook' }],
			hasUnresolvedPlaceholders: true,
			verificationReadiness: { status: 'needs_setup', reason: 'unresolved-placeholders' },
			setupRequirement: { status: 'required', reason: 'unresolved-placeholders' },
		});
	});

	it('returns a failed result when a created workflow cannot be promoted', async () => {
		const ctx = makeContext({ createWorkflow: 'always_allow' });
		(ctx.workflowService.clearAiTemporary as jest.Mock).mockRejectedValueOnce(
			new Error('temporary marker unavailable'),
		);
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake' },
			context,
		);

		expect(result).toMatchObject({
			success: false,
			workflowId: 'created-wf',
			workflowName: 'Lead intake',
			errors: [
				'Workflow was saved, but failed to finalize temporary state: temporary marker unavailable',
			],
		});
		expect(ctx.aiCreatedWorkflowIds?.has('created-wf')).toBe(true);
	});

	it('honors scoped update approval for pre-approved checkpoint workflow repairs', async () => {
		const ctx = makeContext(
			{ updateWorkflow: 'always_allow' },
			{ allowedUpdateWorkflowIds: new Set(['wf-1']) },
		);
		const service = createWorkflowCodeService(ctx);
		const { context, suspend } = makeToolContext();

		const result = await service.update(
			{ action: 'update', code: validCode, workflowId: 'wf-1', name: 'Lead intake' },
			context,
		);

		expect(suspend).not.toHaveBeenCalled();
		expect(ctx.workflowService.updateFromWorkflowJSON).toHaveBeenCalled();
		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
	});

	it('requires approval when an always-allow update is outside the scoped workflow set', async () => {
		const ctx = makeContext(
			{ updateWorkflow: 'always_allow' },
			{ allowedUpdateWorkflowIds: new Set(['wf-allowed']) },
		);
		const service = createWorkflowCodeService(ctx);
		const suspend = jest.fn().mockRejectedValue(new Error('suspended'));

		const result = await service.update(
			{ action: 'update', code: validCode, workflowId: 'wf-other', name: 'Lead intake' },
			{ resumeData: undefined, suspend } as WorkflowCodeToolContext,
		);

		expect(suspend).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Update workflow Lead intake (ID: wf-other)',
				severity: 'info',
			}),
		);
		expect(ctx.workflowService.updateFromWorkflowJSON).not.toHaveBeenCalled();
		expect(result).toEqual({ success: false, errors: ['Workflow save failed: suspended'] });
	});

	it('returns a failed result when planned build reporting fails after save', async () => {
		const ctx = makeContext(
			{ createWorkflow: 'always_allow' },
			{
				plannedBuildTask: {
					threadId: 'thread-1',
					taskId: 'task-1',
					workItemId: 'wi-1',
					title: 'Build workflow',
					spec: 'Build it',
					plannedTaskService: {
						markSucceeded: jest.fn().mockRejectedValue(new Error('storage unavailable')),
					},
					workflowTaskService: {
						reportBuildOutcome: jest.fn().mockResolvedValue({ type: 'done' }),
					},
				} as unknown as InstanceAiContext['plannedBuildTask'],
			},
		);
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake' },
			context,
		);

		expect(ctx.workflowService.createFromWorkflowJSON).toHaveBeenCalled();
		expect(ctx.workflowService.clearAiTemporary).not.toHaveBeenCalled();
		expect(ctx.aiCreatedWorkflowIds?.has('created-wf')).toBe(true);
		expect(result).toMatchObject({
			success: false,
			workflowId: 'created-wf',
			workflowName: 'Lead intake',
			errors: ['Workflow was saved, but failed to update planned task state: storage unavailable'],
		});
	});

	it('does not apply the same patch twice when approval resumes', async () => {
		const ctx = makeContext({});
		const service = createWorkflowCodeService(ctx);
		const input = {
			action: 'update' as const,
			workflowId: 'wf-1',
			patches: [{ old_str: 'Lead intake', new_str: 'Updated intake' }],
		};

		const suspend = jest.fn().mockRejectedValue(new Error('suspended'));
		await service.update(input, { resumeData: undefined, suspend } as WorkflowCodeToolContext);

		expect(ctx.workflowService.updateFromWorkflowJSON).not.toHaveBeenCalled();

		const result = await service.update(input, {
			resumeData: { approved: true },
			suspend: jest.fn(),
		} as WorkflowCodeToolContext);

		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
		expect(ctx.workflowService.updateFromWorkflowJSON).toHaveBeenCalledTimes(1);
	});

	it('does not reuse cached patch code across workflow IDs', async () => {
		const ctx = makeContext({ updateWorkflow: 'always_allow' });
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		await service.update(
			{ action: 'update', code: validCode, workflowId: 'wf-a', name: 'Lead intake' },
			context,
		);
		(ctx.workflowService.getAsWorkflowJSON as jest.Mock).mockClear();

		const result = await service.update(
			{
				action: 'update',
				workflowId: 'wf-b',
				patches: [{ old_str: 'Lead intake', new_str: 'Other intake' }],
			},
			context,
		);

		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
		expect(ctx.workflowService.getAsWorkflowJSON).toHaveBeenCalledWith('wf-b');
	});
});
