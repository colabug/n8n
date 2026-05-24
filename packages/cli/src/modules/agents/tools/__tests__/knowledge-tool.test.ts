import { AgentKnowledgeCommandService } from '../../agent-knowledge-command.service';
import type { AgentKnowledgeService } from '../../agent-knowledge.service';
import { createSearchKnowledgeTool } from '../knowledge-tool';
import { z } from 'zod';

jest.unmock('node:fs/promises');

const agentId = 'agent-1';
const projectId = 'project-1';

describe('search_knowledge tool', () => {
	let commandService: AgentKnowledgeCommandService;
	let knowledgeService: jest.Mocked<Pick<AgentKnowledgeService, 'materializeWorkspace'>>;

	function mockKnowledgeService() {
		return knowledgeService as unknown as AgentKnowledgeService;
	}

	beforeEach(() => {
		commandService = new AgentKnowledgeCommandService();
		knowledgeService = {
			materializeWorkspace: jest.fn(),
		};
	});

	it('describes a top-level object input schema for providers', () => {
		const tool = createSearchKnowledgeTool({
			agentId,
			projectId,
			knowledgeService: mockKnowledgeService(),
			commandService,
		});

		expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
	});

	it('lists uploaded knowledge files', async () => {
		knowledgeService.materializeWorkspace.mockResolvedValue([
			{
				id: 'file-1',
				fileName: 'notes.txt',
				mimeType: 'text/plain',
				fileSizeBytes: 12,
				relativePath: 'file-1-notes.txt',
				searchable: true,
			},
		]);
		const tool = createSearchKnowledgeTool({
			agentId,
			projectId,
			knowledgeService: mockKnowledgeService(),
			commandService,
		});

		await expect(tool.handler?.({ operation: 'list' }, {} as never)).resolves.toMatchObject({
			operation: 'list',
			files: [
				{
					id: 'file-1',
					relativePath: 'file-1-notes.txt',
					searchable: true,
				},
			],
		});
	});

	it('searches materialized text files', async () => {
		knowledgeService.materializeWorkspace.mockImplementation(
			async (_agentId, _projectId, workspaceRoot) => {
				const { writeFile } = await import('node:fs/promises');
				const path = await import('node:path');
				await writeFile(path.join(workspaceRoot, 'file-1-notes.txt'), 'hello\nneedle\n');
				return [
					{
						id: 'file-1',
						fileName: 'notes.txt',
						mimeType: 'text/plain',
						fileSizeBytes: 13,
						relativePath: 'file-1-notes.txt',
						searchable: true,
					},
				];
			},
		);
		const tool = createSearchKnowledgeTool({
			agentId,
			projectId,
			knowledgeService: mockKnowledgeService(),
			commandService,
		});

		const result = await tool.handler?.({ operation: 'search', query: 'needle' }, {} as never);

		expect(result).toMatchObject({
			operation: 'search',
			result: {
				command: 'git_grep',
				exitCode: 0,
			},
		});
		expect((result as { result: { stdout: string } }).result.stdout).toContain(
			'file-1-notes.txt:2:needle',
		);
	});

	it('returns a structured error for non-text PDFs', async () => {
		knowledgeService.materializeWorkspace.mockResolvedValue([
			{
				id: 'file-1',
				fileName: 'document.pdf',
				mimeType: 'application/pdf',
				fileSizeBytes: 200,
				relativePath: 'file-1-document.pdf',
				searchable: false,
			},
		]);
		const tool = createSearchKnowledgeTool({
			agentId,
			projectId,
			knowledgeService: mockKnowledgeService(),
			commandService,
		});

		await expect(
			tool.handler?.({ operation: 'read', file: 'file-1' }, {} as never),
		).resolves.toMatchObject({
			operation: 'read',
			error: 'File "document.pdf" is not readable as plain text in this version.',
		});
	});

	it('reads extracted PDF text when materialized as searchable text', async () => {
		knowledgeService.materializeWorkspace.mockImplementation(
			async (_agentId, _projectId, workspaceRoot) => {
				const { writeFile } = await import('node:fs/promises');
				const path = await import('node:path');
				await writeFile(path.join(workspaceRoot, 'file-1.pdf.txt'), 'extracted PDF text\n');
				return [
					{
						id: 'file-1',
						fileName: 'document.pdf',
						mimeType: 'text/plain',
						fileSizeBytes: 200,
						relativePath: 'file-1.pdf.txt',
						searchable: true,
					},
				];
			},
		);
		const tool = createSearchKnowledgeTool({
			agentId,
			projectId,
			knowledgeService: mockKnowledgeService(),
			commandService,
		});

		await expect(
			tool.handler?.({ operation: 'read', file: 'file-1' }, {} as never),
		).resolves.toMatchObject({
			operation: 'read',
			files: [
				expect.objectContaining({
					fileName: 'document.pdf',
					relativePath: 'file-1.pdf.txt',
					searchable: true,
				}),
			],
			result: {
				command: 'cat',
				stdout: 'extracted PDF text\n',
			},
		});
	});
});
