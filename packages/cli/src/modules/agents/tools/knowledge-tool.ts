import { Tool } from '@n8n/agents/tool';
import { z } from 'zod';

import {
	AgentKnowledgeCommandService,
	type AgentKnowledgeCommandRequest,
} from '../agent-knowledge-command.service';
import { AgentKnowledgeService } from '../agent-knowledge.service';

const lineRangeSchema = z.object({
	start: z.number().int().min(1),
	end: z.number().int().min(1),
});

const commandRequestSchema = z.discriminatedUnion('command', [
	z.object({
		command: z.literal('git_grep'),
		pattern: z.string().min(1),
		caseInsensitive: z.boolean().optional(),
		fixedStrings: z.boolean().optional(),
		context: z.number().int().min(0).max(5).optional(),
		files: z.array(z.string()).max(10).optional(),
	}),
	z.object({
		command: z.literal('find'),
		name: z.string().optional(),
		maxDepth: z.number().int().min(1).max(5).optional(),
	}),
	z.object({
		command: z.literal('cat'),
		file: z.string().min(1),
	}),
	z.object({
		command: z.literal('sed'),
		file: z.string().min(1),
		startLine: z.number().int().min(1),
		endLine: z.number().int().min(1),
	}),
	z.object({
		command: z.literal('awk'),
		file: z.string().min(1),
		fieldSeparator: z.string().min(1).max(4).optional(),
		printFields: z.array(z.number().int().min(1).max(50)).min(1).max(10),
	}),
	z.object({
		command: z.literal('xargs'),
		commandName: z.literal('cat'),
		files: z.array(z.string().min(1)).min(1).max(10),
	}),
]);

const searchKnowledgeInputSchema = z.object({
	operation: z.enum(['list', 'search', 'read', 'command']),
	query: z.string().min(1).optional(),
	caseInsensitive: z.boolean().optional(),
	fixedStrings: z.boolean().optional(),
	context: z.number().int().min(0).max(5).optional(),
	files: z.array(z.string()).max(10).optional(),
	file: z.string().min(1).optional(),
	lineRange: lineRangeSchema.optional(),
	request: commandRequestSchema.optional(),
});

const listInputSchema = z.object({ operation: z.literal('list') });
const searchInputSchema = searchKnowledgeInputSchema.extend({
	operation: z.literal('search'),
	query: z.string().min(1),
});
const readInputSchema = searchKnowledgeInputSchema.extend({
	operation: z.literal('read'),
	file: z.string().min(1),
});
const commandInputSchema = searchKnowledgeInputSchema.extend({
	operation: z.literal('command'),
	request: commandRequestSchema,
});

const knowledgeFileOutputSchema = z.object({
	id: z.string(),
	fileName: z.string(),
	mimeType: z.string(),
	fileSizeBytes: z.number(),
	relativePath: z.string(),
	searchable: z.boolean(),
});

const commandResultOutputSchema = z.object({
	command: z.enum(['git_grep', 'find', 'cat', 'sed', 'awk', 'xargs']),
	exitCode: z.number().nullable(),
	stdout: z.string(),
	stderr: z.string(),
	truncated: z.boolean(),
});

const searchKnowledgeOutputSchema = z.object({
	operation: z.enum(['list', 'search', 'read', 'command']),
	files: z.array(knowledgeFileOutputSchema),
	result: commandResultOutputSchema.optional(),
	error: z.string().optional(),
});

type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInputSchema>;
type ParsedSearchKnowledgeInput =
	| z.infer<typeof listInputSchema>
	| z.infer<typeof searchInputSchema>
	| z.infer<typeof readInputSchema>
	| z.infer<typeof commandInputSchema>;
type SearchKnowledgeOutput = z.infer<typeof searchKnowledgeOutputSchema>;

export function createSearchKnowledgeTool({
	agentId,
	projectId,
	knowledgeService,
	commandService,
}: {
	agentId: string;
	projectId: string;
	knowledgeService: AgentKnowledgeService;
	commandService: AgentKnowledgeCommandService;
}) {
	return new Tool('search_knowledge')
		.description(
			'List, read, and search files uploaded to this agent knowledge base. ' +
				'Use this when the user asks about uploaded documents or facts likely contained in them.',
		)
		.systemInstruction(
			'Use search_knowledge to inspect uploaded knowledge files. Do not claim a file says something ' +
				'unless you found it via list, search, read, or command. Prefer search before reading large files.',
		)
		.input(searchKnowledgeInputSchema)
		.output(searchKnowledgeOutputSchema)
		.handler(async (input): Promise<SearchKnowledgeOutput> => {
			return await commandService.withWorkspace(async (workspaceRoot) => {
				const files = await knowledgeService.materializeWorkspace(
					agentId,
					projectId,
					workspaceRoot,
				);

				try {
					return await handleKnowledgeOperation(
						parseSearchKnowledgeInput(input),
						workspaceRoot,
						files,
						commandService,
					);
				} catch (error) {
					return {
						operation: input.operation,
						files,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			});
		})
		.build();
}

async function handleKnowledgeOperation(
	input: ParsedSearchKnowledgeInput,
	workspaceRoot: string,
	files: Awaited<ReturnType<AgentKnowledgeService['materializeWorkspace']>>,
	commandService: AgentKnowledgeCommandService,
): Promise<SearchKnowledgeOutput> {
	switch (input.operation) {
		case 'list':
			return {
				operation: 'list',
				files,
			};
		case 'search':
			return {
				operation: 'search',
				files,
				result: await commandService.run(workspaceRoot, {
					command: 'git_grep',
					pattern: input.query,
					caseInsensitive: input.caseInsensitive,
					fixedStrings: input.fixedStrings ?? true,
					context: input.context,
					files: mapFileReferences(files, input.files),
				}),
			};
		case 'read': {
			const file = files.find(
				(candidate) => candidate.relativePath === input.file || candidate.id === input.file,
			);
			if (file && !file.searchable) {
				return {
					operation: 'read',
					files,
					error: `File "${file.fileName}" is not readable as plain text in this version.`,
				};
			}
			const request: AgentKnowledgeCommandRequest = input.lineRange
				? {
						command: 'sed',
						file: file?.relativePath ?? input.file,
						startLine: input.lineRange.start,
						endLine: input.lineRange.end,
					}
				: { command: 'cat', file: file?.relativePath ?? input.file };
			return {
				operation: 'read',
				files,
				result: await commandService.run(workspaceRoot, request),
			};
		}
		case 'command':
			return {
				operation: 'command',
				files,
				result: await commandService.run(
					workspaceRoot,
					mapCommandFileReferences(files, input.request),
				),
			};
	}
}

function parseSearchKnowledgeInput(input: SearchKnowledgeInput): ParsedSearchKnowledgeInput {
	switch (input.operation) {
		case 'list':
			return listInputSchema.parse(input);
		case 'search':
			return searchInputSchema.parse(input);
		case 'read':
			return readInputSchema.parse(input);
		case 'command':
			return commandInputSchema.parse(input);
	}
}

function mapFileReferences(
	files: Awaited<ReturnType<AgentKnowledgeService['materializeWorkspace']>>,
	requestedFiles?: string[],
) {
	return requestedFiles?.map(
		(file) => files.find((candidate) => candidate.id === file)?.relativePath ?? file,
	);
}

function mapCommandFileReferences(
	files: Awaited<ReturnType<AgentKnowledgeService['materializeWorkspace']>>,
	request: AgentKnowledgeCommandRequest,
): AgentKnowledgeCommandRequest {
	if (request.command === 'cat' || request.command === 'sed' || request.command === 'awk') {
		return {
			...request,
			file: files.find((file) => file.id === request.file)?.relativePath ?? request.file,
		};
	}
	if (request.command === 'git_grep') {
		return { ...request, files: mapFileReferences(files, request.files) };
	}
	if (request.command === 'xargs') {
		return { ...request, files: mapFileReferences(files, request.files) ?? request.files };
	}
	return request;
}
