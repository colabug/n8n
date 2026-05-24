import { Tool } from '@n8n/agents/tool';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import type { AgentKnowledgeCommandService } from '../agent-knowledge-command.service';
import type { AgentKnowledgeService } from '../agent-knowledge.service';
import {
	getSearchKnowledgeOperation,
	parseSearchKnowledgeInput,
	searchKnowledgeInputSchema,
	searchKnowledgeOutputSchema,
	type CsvFilter,
	type CsvQueryInput,
	type InternalKnowledgeCommandRequest,
	type InternalKnowledgeCommandResult,
	type ParsedSearchKnowledgeInput,
	type SearchKnowledgeOutput,
} from './knowledge-tool.domain';

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
				'unless you found it via list, search, read, or csv_query. Prefer csv_query for CSV row/column lookups.',
		)
		.input(searchKnowledgeInputSchema)
		.output(searchKnowledgeOutputSchema)
		.handler(async (input: unknown): Promise<SearchKnowledgeOutput> => {
			let parsedInput: ParsedSearchKnowledgeInput;
			try {
				parsedInput = parseSearchKnowledgeInput(input);
			} catch (error) {
				return {
					operation: getSearchKnowledgeOperation(input),
					files: [],
					error: error instanceof Error ? error.message : String(error),
				};
			}

			if (parsedInput.operation === 'list') {
				return {
					operation: 'list',
					files: await knowledgeService.listWorkspaceFiles(agentId, projectId),
				};
			}

			return await commandService.withWorkspace(async (workspaceRoot) => {
				const files = await knowledgeService.materializeWorkspace(
					agentId,
					projectId,
					workspaceRoot,
					{ fileReferences: getRequiredFileReferences(parsedInput) },
				);

				try {
					return await handleKnowledgeOperation(parsedInput, workspaceRoot, files, commandService);
				} catch (error) {
					return {
						operation: parsedInput.operation,
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
				result: await runInternalCommand(commandService, workspaceRoot, {
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
			const request: InternalKnowledgeCommandRequest = input.lineRange
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
				result: await runInternalCommand(commandService, workspaceRoot, request),
			};
		}
		case 'csv_query':
			return {
				operation: 'csv_query',
				files,
				csv: await queryCsv(workspaceRoot, files, input),
			};
	}
}

async function runInternalCommand(
	commandService: AgentKnowledgeCommandService,
	workspaceRoot: string,
	request: InternalKnowledgeCommandRequest,
): Promise<InternalKnowledgeCommandResult> {
	const result = await commandService.run(workspaceRoot, request);
	return { ...result, command: request.command };
}

function getRequiredFileReferences(input: ParsedSearchKnowledgeInput) {
	if (input.operation === 'search') return input.files;
	if (input.operation === 'read' || input.operation === 'csv_query') return [input.file];
	return undefined;
}

async function queryCsv(
	workspaceRoot: string,
	files: Awaited<ReturnType<AgentKnowledgeService['materializeWorkspace']>>,
	input: CsvQueryInput,
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

	const headers: string[] = [];
	const limit = input.limit ?? 20;
	const rows: string[][] = [];
	const rowNumbers: number[] = [];
	let matched = 0;
	const filePath = path.join(workspaceRoot, file.relativePath);
	const { parse } = await import('csv-parse');
	const readStream = createReadStream(filePath);
	const parser = readStream.pipe(
		parse({
			columns: (parsedHeaders: string[]) => {
				headers.push(...parsedHeaders);
				validateCsvColumns(headers, file.fileName, input);
				return parsedHeaders;
			},
			skip_empty_lines: true,
			bom: true,
			info: true,
			relax_column_count: true,
		}),
	);
	try {
		for await (const { record, info } of parser as AsyncIterable<{
			record: Record<string, unknown>;
			info: { lines: number };
		}>) {
			if (!matchesFilters(record, input.where ?? [])) continue;
			matched++;
			if (rows.length < limit) {
				rows.push(input.select.map((column) => normaliseCsvValue(record[column])));
				rowNumbers.push(info.lines);
			}
		}
	} finally {
		readStream.destroy();
		parser.destroy();
	}
	if (headers.length === 0) validateCsvColumns(headers, file.fileName, input);

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

function validateCsvColumns(headers: string[], fileName: string, input: CsvQueryInput) {
	for (const column of input.select) {
		if (!headers.includes(column)) {
			throw new Error(`CSV column "${column}" not found in "${fileName}"`);
		}
	}
	for (const filter of input.where ?? []) {
		if (!headers.includes(filter.column)) {
			throw new Error(`CSV column "${filter.column}" not found in "${fileName}"`);
		}
	}
}

function matchesFilters(record: Record<string, unknown>, filters: CsvFilter[]) {
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
