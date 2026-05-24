import { Tool } from '@n8n/agents/tool';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { JSONSchema7 } from 'json-schema';
import type {
	AgentKnowledgeCommandService,
	AgentKnowledgeCommandRequest,
} from '../agent-knowledge-command.service';
import type { AgentKnowledgeService } from '../agent-knowledge.service';

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

const csvFilterSchema = z.discriminatedUnion('op', [
	z.object({
		column: z.string().min(1),
		op: z.literal('eq'),
		value: z.string(),
	}),
	z.object({
		column: z.string().min(1),
		op: z.literal('in'),
		value: z.array(z.string()).min(1).max(50),
	}),
	z.object({
		column: z.string().min(1),
		op: z.literal('contains'),
		value: z.string(),
	}),
]);

const listInputSchema = z.object({ operation: z.literal('list') }).strict();
const searchInputSchema = z
	.object({
		operation: z.literal('search'),
		query: z.string().min(1),
		caseInsensitive: z.boolean().optional(),
		fixedStrings: z.boolean().optional(),
		context: z.number().int().min(0).max(5).optional(),
		files: z.array(z.string()).max(10).optional(),
	})
	.strict();
const readInputSchema = z
	.object({
		operation: z.literal('read'),
		file: z.string().min(1),
		lineRange: lineRangeSchema.optional(),
	})
	.strict();
const commandInputSchema = z
	.object({
		operation: z.literal('command'),
		request: commandRequestSchema,
	})
	.strict();
const csvQueryInputSchema = z
	.object({
		operation: z.literal('csv_query'),
		file: z.string().min(1),
		select: z.array(z.string().min(1)).min(1).max(50),
		where: z.array(csvFilterSchema).max(10).optional(),
		limit: z.number().int().min(1).max(100).default(20),
	})
	.strict();

const searchKnowledgeParsingSchema = z.discriminatedUnion('operation', [
	listInputSchema,
	searchInputSchema,
	readInputSchema,
	commandInputSchema,
	csvQueryInputSchema,
]);

const searchKnowledgeInputSchema: JSONSchema7 = {
	type: 'object',
	description:
		'Use exactly one operation shape. Do not include fields from other operations. ' +
		'Use csv_query, not search/read/command, for CSV row/column lookups.',
	additionalProperties: false,
	required: ['operation'],
	properties: {
		operation: {
			type: 'string',
			description:
				'Operation to perform. Allowed values: list, search, read, command, csv_query. For CSV row/column lookups, use csv_query.',
		},
		query: {
			type: 'string',
			minLength: 1,
			description: 'For operation=search only: search pattern.',
		},
		caseInsensitive: {
			type: 'boolean',
			description: 'For operation=search only: run case-insensitive search.',
		},
		fixedStrings: {
			type: 'boolean',
			description:
				'For operation=search only: treat query as a fixed string instead of a regex. Defaults to true.',
		},
		context: {
			type: 'integer',
			minimum: 0,
			maximum: 5,
			description: 'For operation=search only: number of surrounding context lines.',
		},
		files: {
			type: 'array',
			maxItems: 10,
			items: { type: 'string' },
			description: 'For operation=search only: optional file ids or relative paths to search.',
		},
		file: {
			type: 'string',
			minLength: 1,
			description: 'For operation=read or csv_query: file id or relative path.',
		},
		lineRange: {
			type: 'object',
			additionalProperties: false,
			description: 'For operation=read only: optional line range to read.',
			properties: {
				start: { type: 'integer', minimum: 1 },
				end: { type: 'integer', minimum: 1 },
			},
		},
		request: {
			type: 'object',
			description:
				'For operation=command only: low-level file command request. Allowed commands: git_grep, find, cat, sed, awk, xargs.',
			additionalProperties: true,
		},
		where: {
			type: 'array',
			maxItems: 10,
			description:
				'For operation=csv_query only: row filters ANDed together. Each filter has column, op, and value. Allowed op values: eq, in, contains. For op=in, value must be an array of strings.',
			items: {
				type: 'object',
				additionalProperties: true,
				required: ['column', 'op', 'value'],
				properties: {
					column: { type: 'string', minLength: 1 },
					op: {
						type: 'string',
						description: 'Allowed values: eq, in, contains.',
					},
					value: {
						description:
							'String value for eq/contains, or array of strings for in. Local validation enforces the exact shape.',
					},
				},
			},
		},
		select: {
			type: 'array',
			minItems: 1,
			maxItems: 50,
			items: { type: 'string', minLength: 1 },
			description: 'For operation=csv_query only: columns to return.',
		},
		limit: {
			type: 'integer',
			minimum: 1,
			maximum: 100,
			default: 20,
			description: 'For operation=csv_query only: maximum rows to return. Defaults to 20.',
		},
	},
};

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

const csvQueryResultOutputSchema = z.object({
	fileName: z.string(),
	relativePath: z.string(),
	columns: z.array(z.string()),
	rowNumbers: z.array(z.number()),
	rows: z.array(z.array(z.string())),
	rowCount: z.number(),
	truncated: z.boolean(),
});

const searchKnowledgeOutputSchema = z.object({
	operation: z.enum(['list', 'search', 'read', 'command', 'csv_query']),
	files: z.array(knowledgeFileOutputSchema),
	result: commandResultOutputSchema.optional(),
	csv: csvQueryResultOutputSchema.optional(),
	error: z.string().optional(),
});

type ParsedSearchKnowledgeInput =
	| z.infer<typeof listInputSchema>
	| z.infer<typeof searchInputSchema>
	| z.infer<typeof readInputSchema>
	| z.infer<typeof commandInputSchema>
	| z.infer<typeof csvQueryInputSchema>;
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
			'List, read, search, and query files uploaded to this agent knowledge base. ' +
				'Use this when the user asks about uploaded documents or facts likely contained in them.',
		)
		.systemInstruction(
			'Use search_knowledge to inspect uploaded knowledge files. Do not claim a file says something ' +
				'unless you found it via list, search, read, command, or csv_query. Prefer csv_query for CSV row/column lookups.',
		)
		.input(searchKnowledgeInputSchema)
		.output(searchKnowledgeOutputSchema)
		.handler(async (input: unknown): Promise<SearchKnowledgeOutput> => {
			return await commandService.withWorkspace(async (workspaceRoot) => {
				const files = await knowledgeService.materializeWorkspace(
					agentId,
					projectId,
					workspaceRoot,
				);

				try {
					const parsedInput = parseSearchKnowledgeInput(input);
					return await handleKnowledgeOperation(parsedInput, workspaceRoot, files, commandService);
				} catch (error) {
					return {
						operation: getOperation(input),
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
		case 'csv_query':
			return {
				operation: 'csv_query',
				files,
				csv: await queryCsv(workspaceRoot, files, input),
			};
	}
}

function parseSearchKnowledgeInput(input: unknown): ParsedSearchKnowledgeInput {
	return searchKnowledgeParsingSchema.parse(input);
}

function getOperation(input: unknown): SearchKnowledgeOutput['operation'] {
	const parsed = z
		.object({ operation: z.enum(['list', 'search', 'read', 'command', 'csv_query']) })
		.safeParse(input);
	return parsed.success ? parsed.data.operation : 'command';
}

async function queryCsv(
	workspaceRoot: string,
	files: Awaited<ReturnType<AgentKnowledgeService['materializeWorkspace']>>,
	input: z.infer<typeof csvQueryInputSchema>,
) {
	const file = files.find(
		(candidate) => candidate.relativePath === input.file || candidate.id === input.file,
	);
	if (!file) {
		throw new Error(`File "${input.file}" not found`);
	}
	if (!file.searchable || !isCsvFile(file)) {
		throw new Error(`File "${file.fileName}" is not queryable as CSV.`);
	}

	const csvText = await readFile(path.join(workspaceRoot, file.relativePath), 'utf8');
	const { parse } = await import('csv-parse/sync');
	const records: Array<{ record: Record<string, unknown>; info: { lines: number } }> = parse(
		csvText,
		{
			columns: true,
			skip_empty_lines: true,
			bom: true,
			info: true,
			relax_column_count: true,
		},
	);

	const headers = records.length > 0 ? Object.keys(records[0].record) : parseHeader(csvText);
	for (const column of input.select) {
		if (!headers.includes(column)) {
			throw new Error(`CSV column "${column}" not found in "${file.fileName}"`);
		}
	}
	for (const filter of input.where ?? []) {
		if (!headers.includes(filter.column)) {
			throw new Error(`CSV column "${filter.column}" not found in "${file.fileName}"`);
		}
	}

	const limit = input.limit ?? 20;
	const rows: string[][] = [];
	const rowNumbers: number[] = [];
	let matched = 0;
	for (const { record, info } of records) {
		if (!matchesFilters(record, input.where ?? [])) continue;
		matched++;
		if (rows.length < limit) {
			rows.push(input.select.map((column) => normaliseCsvValue(record[column])));
			rowNumbers.push(info.lines);
		}
	}

	return {
		fileName: file.fileName,
		relativePath: file.relativePath,
		columns: input.select,
		rowNumbers,
		rows,
		rowCount: matched,
		truncated: matched > rows.length,
	};
}

function isCsvFile(
	file: Awaited<ReturnType<AgentKnowledgeService['materializeWorkspace']>>[number],
) {
	return file.mimeType === 'text/csv' || file.relativePath.toLowerCase().endsWith('.csv');
}

function parseHeader(csvText: string) {
	const [firstLine = ''] = csvText.split(/\r?\n/, 1);
	return firstLine.split(',').map((column) => column.trim());
}

function matchesFilters(
	record: Record<string, unknown>,
	filters: Array<z.infer<typeof csvFilterSchema>>,
) {
	return filters.every((filter) => {
		const value = normaliseCsvValue(record[filter.column]);
		if (filter.op === 'eq') return value === filter.value;
		if (filter.op === 'contains') return value.includes(filter.value);
		return filter.value.includes(value);
	});
}

function normaliseCsvValue(value: unknown) {
	if (value === null || value === undefined) return '';
	return String(value);
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
