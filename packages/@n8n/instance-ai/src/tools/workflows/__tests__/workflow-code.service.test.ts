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

	function makeContext(permissions: Partial<Permissions>): InstanceAiContext {
		return {
			userId: 'user-1',
			permissions: permissions as Permissions,
			workflowService: {
				createFromWorkflowJSON: jest.fn().mockResolvedValue({ id: 'created-wf' }),
				updateFromWorkflowJSON: jest.fn().mockResolvedValue({ id: 'wf-1' }),
				getAsWorkflowJSON: jest.fn().mockResolvedValue(validWorkflow),
			},
			executionService: {},
			credentialService: { list: jest.fn().mockResolvedValue([]) },
			nodeService: {},
			dataTableService: {},
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
		expect(result).toMatchObject({
			success: true,
			workflowId: 'created-wf',
			workflowName: 'Lead intake',
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
});
