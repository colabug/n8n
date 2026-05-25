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

	it('requires the workflow-builder skill when runtime skill tracking is active', async () => {
		const ctx = makeContext(
			{ createWorkflow: 'always_allow' },
			{ loadedSkills: new Set<string>() },
		);
		const service = createWorkflowCodeService(ctx);
		const { context, suspend } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake' },
			context,
		);

		expect(result).toEqual({
			success: false,
			errors: [
				'Load the workflow-builder skill with load_skill before calling workflows(action="create"|"update").',
			],
		});
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
		expect(ctx.workflowService.createFromWorkflowJSON).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Lead intake' }),
			{},
		);
		expect(ctx.workflowService.clearAiTemporary).not.toHaveBeenCalled();
		expect(ctx.aiCreatedWorkflowIds?.has('created-wf')).toBeUndefined();
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
						id: 'webhook',
						name: 'Webhook',
						type: 'n8n-nodes-base.webhook',
						typeVersion: 2,
						position: [0, 0],
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

	it('keeps explicit temporary create outputs eligible for cleanup', async () => {
		const ctx = makeContext({ createWorkflow: 'always_allow' });
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake', temporary: true },
			context,
		);

		expect(result).toMatchObject({
			success: true,
			workflowId: 'created-wf',
			workflowName: 'Lead intake',
			temporary: true,
		});
		expect(ctx.workflowService.createFromWorkflowJSON).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Lead intake' }),
			{ markAsAiTemporary: true },
		);
		expect(ctx.aiCreatedWorkflowIds?.has('created-wf')).toBe(true);
		expect(ctx.workflowService.clearAiTemporary).not.toHaveBeenCalled();
	});

	it('rejects temporary creates for planned build tasks before saving', async () => {
		const ctx = makeContext(
			{ createWorkflow: 'always_allow' },
			{
				plannedBuildTask: {
					threadId: 'thread-1',
					taskId: 'task-1',
					workItemId: 'wi-1',
					title: 'Build workflow',
					spec: 'Build it',
					plannedTaskService: { markSucceeded: jest.fn() },
				} as unknown as InstanceAiContext['plannedBuildTask'],
			},
		);
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake', temporary: true },
			context,
		);

		expect(ctx.workflowService.createFromWorkflowJSON).not.toHaveBeenCalled();
		expect(mockedParseAndValidate).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: false,
			errors: [
				'Do not set temporary: true for planned build tasks. Omit temporary for final planned workflow deliverables.',
			],
		});
	});

	it('does not reuse previous create code for a later patch-mode create', async () => {
		const ctx = makeContext({ createWorkflow: 'always_allow' });
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		await service.create({ action: 'create', code: validCode, name: 'Workflow A' }, context);

		const result = await service.create(
			{
				action: 'create',
				name: 'Workflow B',
				patches: [{ old_str: 'Lead intake', new_str: 'Workflow B' }],
			},
			context,
		);

		expect(result).toEqual({
			success: false,
			errors: [
				'Patch mode requires either previous workflow code in this turn or a workflowId to fetch from.',
			],
		});
		expect(ctx.workflowService.createFromWorkflowJSON).toHaveBeenCalledTimes(1);
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

	it('does not let a planned create task update arbitrary workflows without approval', async () => {
		const ctx = makeContext(
			{ createWorkflow: 'always_allow', updateWorkflow: 'always_allow' },
			{
				plannedBuildTask: {
					threadId: 'thread-1',
					taskId: 'task-1',
					workItemId: 'wi-1',
					title: 'Build workflow',
					spec: 'Build it',
					plannedTaskService: { markSucceeded: jest.fn() },
				} as unknown as InstanceAiContext['plannedBuildTask'],
				allowedUpdateWorkflowIds: new Set(),
			},
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

	it('does not let a planned update task create a new workflow without approval', async () => {
		const ctx = makeContext(
			{ createWorkflow: 'always_allow', updateWorkflow: 'always_allow' },
			{
				plannedBuildTask: {
					threadId: 'thread-1',
					taskId: 'task-1',
					workItemId: 'wi-1',
					title: 'Update workflow',
					spec: 'Update it',
					workflowId: 'wf-1',
					plannedTaskService: { markSucceeded: jest.fn() },
				} as unknown as InstanceAiContext['plannedBuildTask'],
				allowedUpdateWorkflowIds: new Set(['wf-1']),
			},
		);
		const service = createWorkflowCodeService(ctx);
		const suspend = jest.fn().mockRejectedValue(new Error('suspended'));

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake' },
			{ resumeData: undefined, suspend } as WorkflowCodeToolContext,
		);

		expect(suspend).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Create workflow Lead intake',
				severity: 'info',
			}),
		);
		expect(ctx.workflowService.createFromWorkflowJSON).not.toHaveBeenCalled();
		expect(result).toEqual({ success: false, errors: ['Workflow save failed: suspended'] });
	});

	it('returns a successful save with warning when planned build reporting fails after save', async () => {
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
						getGraph: jest.fn().mockResolvedValue({
							tasks: [{ id: 'task-1', status: 'running' }],
						}),
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
		expect(ctx.aiCreatedWorkflowIds?.has('created-wf')).toBeUndefined();
		expect(result).toMatchObject({
			success: true,
			workflowId: 'created-wf',
			workflowName: 'Lead intake',
			warnings: ['Workflow was saved, but planned task state update failed: storage unavailable'],
		});
	});

	it('does not cache recovered success when build outcome reporting fails', async () => {
		const onSavedWorkflowBuildOutcome = jest.fn();
		const markSucceeded = jest.fn();
		const reportBuildOutcome = jest.fn().mockRejectedValue(new Error('loop storage unavailable'));
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
						getGraph: jest.fn().mockResolvedValue({
							tasks: [{ id: 'task-1', status: 'running' }],
						}),
						markSucceeded,
					},
					workflowTaskService: { reportBuildOutcome },
					onSavedWorkflowBuildOutcome,
				} as unknown as InstanceAiContext['plannedBuildTask'],
			},
		);
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake' },
			context,
		);

		expect(result).toMatchObject({
			success: true,
			workflowId: 'created-wf',
			warnings: [
				'Workflow was saved, but planned task state update failed: loop storage unavailable',
			],
		});
		expect(reportBuildOutcome).toHaveBeenCalled();
		expect(onSavedWorkflowBuildOutcome).not.toHaveBeenCalled();
		expect(markSucceeded).not.toHaveBeenCalled();
	});

	it('reports planned build success after the workflow save succeeds', async () => {
		const markSucceeded = jest.fn().mockResolvedValue(undefined);
		const reportBuildOutcome = jest.fn().mockResolvedValue({ type: 'done' });
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
						getGraph: jest.fn().mockResolvedValue({
							tasks: [{ id: 'task-1', status: 'running' }],
						}),
						markSucceeded,
					},
					workflowTaskService: { reportBuildOutcome },
				} as unknown as InstanceAiContext['plannedBuildTask'],
			},
		);
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake' },
			context,
		);

		expect(result).toMatchObject({ success: true, workflowId: 'created-wf' });
		expect(ctx.workflowService.clearAiTemporary).not.toHaveBeenCalled();
		expect(reportBuildOutcome).toHaveBeenCalled();
		expect(markSucceeded).toHaveBeenCalled();
	});

	it('does not report planned build success when the task is no longer running', async () => {
		const markSucceeded = jest.fn();
		const reportBuildOutcome = jest.fn();
		const onSavedWorkflowBuildOutcome = jest.fn();
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
						getGraph: jest.fn().mockResolvedValue({
							tasks: [
								{
									id: 'task-1',
									status: 'succeeded',
									outcome: { workflowId: 'wf-a' },
								},
							],
						}),
						markSucceeded,
					},
					workflowTaskService: { reportBuildOutcome },
					onSavedWorkflowBuildOutcome,
				} as unknown as InstanceAiContext['plannedBuildTask'],
			},
		);
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		const result = await service.create(
			{ action: 'create', code: validCode, name: 'Lead intake' },
			context,
		);

		expect(result).toMatchObject({ success: true, workflowId: 'created-wf' });
		expect(reportBuildOutcome).not.toHaveBeenCalled();
		expect(onSavedWorkflowBuildOutcome).not.toHaveBeenCalled();
		expect(markSucceeded).not.toHaveBeenCalled();
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

	it('does not cache invalid existing-workflow code as the next patch base', async () => {
		const ctx = makeContext({ updateWorkflow: 'always_allow' });
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		mockedParseAndValidate.mockImplementationOnce(() => {
			throw new Error('Failed to parse workflow code: syntax error');
		});

		await service.update(
			{
				action: 'update',
				code: "export default workflow('wf-1', 'Broken intake')",
				workflowId: 'wf-1',
			},
			context,
		);

		(ctx.workflowService.getAsWorkflowJSON as jest.Mock).mockClear();

		const result = await service.update(
			{
				action: 'update',
				workflowId: 'wf-1',
				patches: [{ old_str: 'Lead intake', new_str: 'Recovered intake' }],
			},
			context,
		);

		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
		expect(ctx.workflowService.getAsWorkflowJSON).toHaveBeenCalledWith('wf-1');
	});

	it('refetches workflow code after an external mutation invalidates the cache', async () => {
		const ctx = makeContext({ updateWorkflow: 'always_allow' });
		const service = createWorkflowCodeService(ctx);
		const { context } = makeToolContext();

		await service.update(
			{ action: 'update', code: validCode, workflowId: 'wf-1', name: 'Lead intake' },
			context,
		);
		service.invalidate('wf-1');
		(ctx.workflowService.getAsWorkflowJSON as jest.Mock).mockClear();

		const result = await service.update(
			{
				action: 'update',
				workflowId: 'wf-1',
				patches: [{ old_str: 'Lead intake', new_str: 'Refetched intake' }],
			},
			context,
		);

		expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
		expect(ctx.workflowService.getAsWorkflowJSON).toHaveBeenCalledWith('wf-1');
	});
});
