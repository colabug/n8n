import type { JSONSchema7 } from 'json-schema';
import { z } from 'zod';

import type {
	AgentKnowledgeCommandRequest,
	AgentKnowledgeCommandResult,
} from '../agent-knowledge-command.service';

export const DEFAULT_SEARCH_HEAD_LIMIT = 250;

const lineRangeSchema = z.object({
	start: z.number().int().min(1),
	end: z.number().int().min(1),
});

const searchOutputModeSchema = z.enum(['files_with_matches', 'content', 'count']);
const searchMatchModeSchema = z.enum(['any', 'all_on_same_line', 'all_within_lines']);

export const csvFilterSchema = z.discriminatedUnion('op', [
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
		query: z.string().min(1).optional(),
		queries: z.array(z.string().min(1)).min(1).max(5).optional(),
		match_mode: searchMatchModeSchema.default('any'),
		output_mode: searchOutputModeSchema.default('files_with_matches'),
		caseInsensitive: z.boolean().optional(),
		fixedStrings: z.boolean().optional(),
		context: z.number().int().min(0).max(5).optional(),
		files: z.array(z.string()).max(10).optional(),
		offset: z.number().int().min(0).default(0),
		head_limit: z.number().int().min(0).default(DEFAULT_SEARCH_HEAD_LIMIT),
	})
	.strict();
const readInputSchema = z
	.object({
		operation: z.literal('read'),
		file: z.string().min(1),
		lineRange: lineRangeSchema.optional(),
	})
	.strict();
export const csvQueryInputSchema = z
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
	csvQueryInputSchema,
]);

export const searchKnowledgeInputSchema: JSONSchema7 = {
	type: 'object',
	description:
		'Use exactly one operation shape. Do not include fields from other operations. ' +
		'Use csv_query, not search/read, for CSV row/column lookups.',
	additionalProperties: false,
	required: ['operation'],
	properties: {
		operation: {
			type: 'string',
			description:
				'Operation to perform. Allowed values: list, search, read, csv_query. For CSV row/column lookups, use csv_query.',
		},
		query: {
			type: 'string',
			minLength: 1,
			description:
				'For operation=search only: search pattern. For conceptual multi-term lookup, prefer queries with match_mode instead of writing regex by hand.',
		},
		queries: {
			type: 'array',
			minItems: 1,
			maxItems: 5,
			items: { type: 'string', minLength: 1 },
			description:
				'For operation=search only: multiple literal search terms for conceptual lookup without hand-written regex.',
		},
		match_mode: {
			type: 'string',
			default: 'any',
			description:
				'For operation=search with queries only: any, all_on_same_line, or all_within_lines. Use all_within_lines to find concepts near each other without regex.',
		},
		output_mode: {
			type: 'string',
			description:
				'For operation=search only: content shows matching lines, files_with_matches shows only matching files (default), count shows match counts. Use content only after narrowing to a file or exact phrase.',
			default: 'files_with_matches',
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
			description:
				'For operation=search only: number of surrounding context lines. Requires output_mode=content.',
		},
		files: {
			type: 'array',
			maxItems: 10,
			items: { type: 'string' },
			description:
				'For operation=search only: optional file ids or relative paths to search. These are tool handles only; do not cite them to users.',
		},
		offset: {
			type: 'integer',
			minimum: 0,
			default: 0,
			description: 'For operation=search only: number of files, counts, or matches to skip.',
		},
		head_limit: {
			type: 'integer',
			minimum: 0,
			default: DEFAULT_SEARCH_HEAD_LIMIT,
			description:
				'For operation=search only: limit output to first N files/counts/lines. Defaults to 250. Pass 0 for unlimited.',
		},
		file: {
			type: 'string',
			minLength: 1,
			description:
				'For operation=read or csv_query: file id or relative path. This is a tool handle only; cite the returned fileName and lineRange instead.',
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
	command: z.enum(['git_grep', 'cat', 'sed']),
	exitCode: z.number().nullable(),
	stdout: z.string(),
	stderr: z.string(),
	truncated: z.boolean(),
	citation: z
		.object({
			fileName: z.string(),
			lineRange: lineRangeSchema.optional(),
			instruction: z.string(),
		})
		.optional(),
});

const searchMatchOutputSchema = z.object({
	fileId: z.string(),
	fileName: z.string(),
	relativePath: z.string(),
	lineNumber: z.number(),
	text: z.string(),
	readRange: lineRangeSchema,
	truncated: z.boolean().optional(),
});

const searchFileOutputSchema = z.object({
	id: z.string(),
	fileName: z.string(),
	relativePath: z.string(),
	matchCount: z.number(),
});

const searchResultOutputSchema = z.object({
	mode: searchOutputModeSchema,
	query: z.string(),
	queries: z.array(z.string()).optional(),
	matchMode: searchMatchModeSchema.optional(),
	totalMatchingFiles: z.number(),
	totalMatchingLines: z.number(),
	files: z.array(searchFileOutputSchema),
	matches: z.array(searchMatchOutputSchema),
	truncated: z.boolean(),
	appliedLimit: z.number().optional(),
	appliedOffset: z.number().optional(),
	nextOffset: z.number().optional(),
	hint: z.string().optional(),
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

export const searchKnowledgeOutputSchema = z.object({
	operation: z.enum(['list', 'search', 'read', 'csv_query']),
	files: z.array(knowledgeFileOutputSchema),
	result: commandResultOutputSchema.optional(),
	search: searchResultOutputSchema.optional(),
	csv: csvQueryResultOutputSchema.optional(),
	error: z.string().optional(),
});

export type ParsedSearchKnowledgeInput = z.infer<typeof searchKnowledgeParsingSchema>;
export type SearchKnowledgeOutput = z.infer<typeof searchKnowledgeOutputSchema>;
export type CsvQueryInput = z.infer<typeof csvQueryInputSchema>;
export type CsvFilter = z.infer<typeof csvFilterSchema>;
export type SearchOutputMode = z.infer<typeof searchOutputModeSchema>;
export type SearchMatchMode = z.infer<typeof searchMatchModeSchema>;
export type SearchMatchOutput = z.infer<typeof searchMatchOutputSchema>;
export type SearchResultOutput = z.infer<typeof searchResultOutputSchema>;
export type InternalKnowledgeCommandRequest = Extract<
	AgentKnowledgeCommandRequest,
	{ command: 'git_grep' | 'cat' | 'sed' }
>;
export type InternalKnowledgeCommandResult = Omit<AgentKnowledgeCommandResult, 'command'> & {
	command: InternalKnowledgeCommandRequest['command'];
};

export function parseSearchKnowledgeInput(input: unknown): ParsedSearchKnowledgeInput {
	return searchKnowledgeParsingSchema.parse(input);
}

export function getSearchKnowledgeOperation(input: unknown): SearchKnowledgeOutput['operation'] {
	const parsed = z
		.object({ operation: z.enum(['list', 'search', 'read', 'csv_query']) })
		.safeParse(input);
	return parsed.success ? parsed.data.operation : 'list';
}
