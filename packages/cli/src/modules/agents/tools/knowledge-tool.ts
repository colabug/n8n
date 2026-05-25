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
	type SearchMatchMode,
	type SearchMatchOutput,
	type SearchOutputMode,
	type SearchResultOutput,
	type SearchKnowledgeOutput,
} from './knowledge-tool.domain';

type WorkspaceFiles = Awaited<ReturnType<AgentKnowledgeService['materializeWorkspace']>>;
type SearchInput = Extract<ParsedSearchKnowledgeInput, { operation: 'search' }>;

const DEFAULT_READ_RANGE_CONTEXT = 6;
const MAX_SEARCH_MATCH_TEXT_LENGTH = 500;
const MULTI_QUERY_WINDOW_LINES = 3;

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
				'unless you found it via list, search, read, or csv_query. Search defaults to output_mode=files_with_matches. ' +
				'Use output_mode=count for counts and output_mode=content only after narrowing to a file or exact phrase. ' +
				'For conceptual multi-term lookup, use queries with match_mode instead of writing regex by hand. ' +
				'Use read for grounded citations. Cite only file names and line ranges from read results. ' +
				'Never mention uploaded file ids, relative paths, binary ids, or storage ids to users. ' +
				'Prefer csv_query for CSV row/column lookups.',
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
	files: WorkspaceFiles,
	commandService: AgentKnowledgeCommandService,
): Promise<SearchKnowledgeOutput> {
	switch (input.operation) {
		case 'list':
			return {
				operation: 'list',
				files,
			};
		case 'search':
			return await runSearchOperation(input, workspaceRoot, files, commandService);
		case 'read': {
			const file = files.find(
				(candidate) => candidate.relativePath === input.file || candidate.id === input.file,
			);
			// Exact-read dedupe needs per-run tool state; avoid a global cache that could leak across agent executions.
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
			const result = await runInternalCommand(commandService, workspaceRoot, request);
			return {
				operation: 'read',
				files,
				result: {
					...result,
					citation: {
						fileName: file?.fileName ?? input.file,
						lineRange: input.lineRange,
						instruction:
							'Cite this source using only fileName and lineRange. Do not cite file ids, relative paths, binary ids, or storage ids.',
					},
				},
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

async function runSearchOperation(
	input: SearchInput,
	workspaceRoot: string,
	files: WorkspaceFiles,
	commandService: AgentKnowledgeCommandService,
): Promise<SearchKnowledgeOutput> {
	if (input.query === undefined && input.queries === undefined) {
		return {
			operation: 'search',
			files,
			error: 'Either query or queries must be provided for search.',
		};
	}
	const requestedFiles = mapFileReferences(files, input.files);
	const primaryPattern = getPrimarySearchPattern(input);
	const commandPattern = getSearchCommandPattern(input);
	const commandFixedStrings = getSearchCommandFixedStrings(input);
	const countResult = await runInternalCommand(commandService, workspaceRoot, {
		command: 'git_grep',
		pattern: commandPattern,
		outputMode: 'count',
		caseInsensitive: input.caseInsensitive,
		fixedStrings: commandFixedStrings,
		files: requestedFiles,
	});
	let counts = parseCountOutput(countResult.stdout, files);
	let multiQueryMatches: SearchMatchOutput[] | undefined;
	if (input.queries) {
		const contentResult = await runInternalCommand(commandService, workspaceRoot, {
			command: 'git_grep',
			pattern: commandPattern,
			caseInsensitive: input.caseInsensitive,
			fixedStrings: commandFixedStrings,
			context: input.context,
			files: requestedFiles,
		});
		multiQueryMatches = filterMultiQueryMatches(
			parseSearchMatches(contentResult.stdout, files),
			input.queries,
			input.match_mode,
			input.caseInsensitive,
		);
		counts = buildCountsFromMatches(multiQueryMatches, files);
	}

	if (input.output_mode === 'files_with_matches') {
		const slicedCounts = sliceResults(counts, input.offset, input.head_limit);
		return {
			operation: 'search',
			files,
			result: toDisplayResult(
				countResult,
				formatSearchFiles(counts, input.offset, input.head_limit),
				slicedCounts.truncated,
			),
			search: buildSearchResult({
				mode: input.output_mode,
				query: primaryPattern,
				queries: input.queries,
				matchMode: input.queries ? input.match_mode : undefined,
				counts,
				matches: [],
				offset: input.offset,
				headLimit: input.head_limit,
				hint: buildSearchHint('files_with_matches', slicedCounts, input.head_limit),
			}),
		};
	}

	if (input.output_mode === 'count') {
		const slicedCounts = sliceResults(counts, input.offset, input.head_limit);
		return {
			operation: 'search',
			files,
			result: toDisplayResult(
				countResult,
				formatSearchCounts(counts, input.offset, input.head_limit),
				slicedCounts.truncated,
			),
			search: buildSearchResult({
				mode: input.output_mode,
				query: primaryPattern,
				queries: input.queries,
				matchMode: input.queries ? input.match_mode : undefined,
				counts,
				matches: [],
				offset: input.offset,
				headLimit: input.head_limit,
				hint: buildSearchHint('count', slicedCounts, input.head_limit),
			}),
		};
	}

	const contentResult = await runInternalCommand(commandService, workspaceRoot, {
		command: 'git_grep',
		pattern: commandPattern,
		caseInsensitive: input.caseInsensitive,
		fixedStrings: commandFixedStrings,
		context: input.context,
		files: requestedFiles,
	});
	const parsedMatches = parseSearchMatches(contentResult.stdout, files);
	const matches = multiQueryMatches ?? parsedMatches;
	const slicedMatches = sliceResults(matches, input.offset, input.head_limit);
	const search = buildSearchResult({
		mode: input.output_mode,
		query: primaryPattern,
		queries: input.queries,
		matchMode: input.queries ? input.match_mode : undefined,
		counts,
		matches: slicedMatches.items,
		offset: input.offset,
		headLimit: input.head_limit,
		nextOffset: slicedMatches.nextOffset,
		hint: buildSearchHint('content', slicedMatches, input.head_limit),
	});
	return {
		operation: 'search',
		files,
		result: toDisplayResult(
			contentResult,
			formatSearchMatches(slicedMatches.items, slicedMatches, input.head_limit),
			search.truncated || contentResult.truncated,
		),
		search,
	};
}

function toDisplayResult(
	result: InternalKnowledgeCommandResult,
	stdout: string,
	truncated = false,
): InternalKnowledgeCommandResult {
	return {
		...result,
		stdout,
		truncated: result.truncated || truncated,
	};
}

function parseCountOutput(stdout: string, files: WorkspaceFiles) {
	const byRelativePath = new Map(files.map((file) => [file.relativePath, file]));
	const counts = stdout
		.split('\n')
		.flatMap((line) => {
			if (line.trim() === '') return [];
			const separatorIndex = line.lastIndexOf(':');
			if (separatorIndex === -1) return [];
			const relativePath = normaliseGrepPath(line.slice(0, separatorIndex));
			const matchCount = Number(line.slice(separatorIndex + 1));
			const file = byRelativePath.get(relativePath);
			if (!file || !Number.isFinite(matchCount) || matchCount <= 0) return [];
			return [
				{
					id: file.id,
					fileName: file.fileName,
					relativePath: file.relativePath,
					matchCount,
					preview: [] as SearchMatchOutput[],
				},
			];
		})
		.sort((left, right) => right.matchCount - left.matchCount);
	return counts;
}

function parseSearchMatches(stdout: string, files: WorkspaceFiles): SearchMatchOutput[] {
	const byRelativePath = new Map(files.map((file) => [file.relativePath, file]));
	return stdout.split('\n').flatMap((line) => {
		const parsed = parseGrepLine(line);
		if (!parsed?.isMatch) return [];
		const file = byRelativePath.get(normaliseGrepPath(parsed.filePath));
		if (!file || parsed.lineNumber === undefined) return [];
		const { text, truncated } = truncateMatchText(line.slice(parsed.contentStartIndex));
		return [
			{
				fileId: file.id,
				fileName: file.fileName,
				relativePath: file.relativePath,
				lineNumber: parsed.lineNumber,
				text,
				readRange: toReadRange(parsed.lineNumber),
				truncated,
			},
		];
	});
}

function truncateMatchText(text: string) {
	if (text.length <= MAX_SEARCH_MATCH_TEXT_LENGTH) return { text };
	return {
		text: `${text.slice(0, MAX_SEARCH_MATCH_TEXT_LENGTH)}... [line truncated; use read for full text]`,
		truncated: true,
	};
}

function filterMultiQueryMatches(
	matches: SearchMatchOutput[],
	queries: string[],
	matchMode: SearchMatchMode,
	caseInsensitive?: boolean,
) {
	const normalizedQueries = queries.map((query) => normalizeSearchText(query, caseInsensitive));
	if (matchMode === 'any') {
		return matches.filter((match) =>
			normalizedQueries.some((query) =>
				normalizeSearchText(match.text, caseInsensitive).includes(query),
			),
		);
	}
	if (matchMode === 'all_on_same_line') {
		return matches.filter((match) => {
			const text = normalizeSearchText(match.text, caseInsensitive);
			return normalizedQueries.every((query) => text.includes(query));
		});
	}
	return matches.filter((match) =>
		hasAllQueriesInNearbyWindow(
			matches,
			match.relativePath,
			match.lineNumber,
			normalizedQueries,
			caseInsensitive,
		),
	);
}

function buildCountsFromMatches(matches: SearchMatchOutput[], files: WorkspaceFiles) {
	const countByRelativePath = new Map<string, number>();
	for (const match of matches) {
		countByRelativePath.set(
			match.relativePath,
			(countByRelativePath.get(match.relativePath) ?? 0) + 1,
		);
	}
	return files
		.flatMap((file) => {
			const matchCount = countByRelativePath.get(file.relativePath) ?? 0;
			if (matchCount === 0) return [];
			return [
				{
					id: file.id,
					fileName: file.fileName,
					relativePath: file.relativePath,
					matchCount,
					preview: [] as SearchMatchOutput[],
				},
			];
		})
		.sort((left, right) => right.matchCount - left.matchCount);
}

function hasAllQueriesInNearbyWindow(
	matches: SearchMatchOutput[],
	relativePath: string,
	lineNumber: number,
	queries: string[],
	caseInsensitive?: boolean,
) {
	const sameFileMatches = matches.filter((match) => match.relativePath === relativePath);
	return sameFileMatches.some((windowStart) => {
		const start = windowStart.lineNumber;
		const end = start + MULTI_QUERY_WINDOW_LINES - 1;
		if (lineNumber < start || lineNumber > end) return false;
		const windowText = sameFileMatches
			.filter((match) => match.lineNumber >= start && match.lineNumber <= end)
			.map((match) => normalizeSearchText(match.text, caseInsensitive))
			.join('\n');
		return queries.every((query) => windowText.includes(query));
	});
}

function normalizeSearchText(text: string, caseInsensitive?: boolean) {
	return caseInsensitive ? text.toLowerCase() : text;
}

function toReadRange(lineNumber: number) {
	return {
		start: Math.max(1, lineNumber - DEFAULT_READ_RANGE_CONTEXT),
		end: lineNumber + DEFAULT_READ_RANGE_CONTEXT,
	};
}

function getPrimarySearchPattern(input: SearchInput) {
	return input.query ?? input.queries?.[0] ?? '';
}

function getSearchCommandPattern(input: SearchInput) {
	if (!input.queries) return input.query ?? '';
	return input.queries.map(escapeExtendedRegex).join('|');
}

function getSearchCommandFixedStrings(input: SearchInput) {
	return input.queries ? false : (input.fixedStrings ?? true);
}

function escapeExtendedRegex(pattern: string) {
	return pattern.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function buildSearchResult({
	mode,
	query,
	queries,
	matchMode,
	counts,
	matches,
	offset,
	headLimit,
	nextOffset,
	hint,
}: {
	mode: SearchOutputMode;
	query: string;
	queries?: string[];
	matchMode?: SearchMatchMode;
	counts: ReturnType<typeof parseCountOutput>;
	matches: SearchMatchOutput[];
	offset: number;
	headLimit: number;
	nextOffset?: number;
	hint?: string;
}): SearchResultOutput {
	const slicedCounts = sliceResults(counts, offset, headLimit);
	const totalMatchingLines = counts.reduce((total, count) => total + count.matchCount, 0);
	const effectiveNextOffset = mode === 'content' ? nextOffset : slicedCounts.nextOffset;
	return {
		mode,
		query,
		queries,
		matchMode,
		totalMatchingFiles: counts.length,
		totalMatchingLines,
		files: slicedCounts.items,
		matches,
		truncated: slicedCounts.truncated || effectiveNextOffset !== undefined,
		appliedLimit:
			(mode === 'content' && effectiveNextOffset !== undefined) || slicedCounts.truncated
				? headLimit
				: undefined,
		appliedOffset: offset > 0 ? offset : undefined,
		nextOffset: effectiveNextOffset,
		hint,
	};
}

function sliceResults<T>(items: T[], offset: number, headLimit: number) {
	const sliced = headLimit === 0 ? items.slice(offset) : items.slice(offset, offset + headLimit);
	return {
		items: sliced,
		truncated: offset + sliced.length < items.length,
		nextOffset: offset + sliced.length < items.length ? offset + sliced.length : undefined,
	};
}

function buildSearchHint(
	mode: SearchOutputMode,
	sliced: { nextOffset?: number; truncated: boolean },
	headLimit: number,
) {
	if (sliced.nextOffset !== undefined) {
		return `Additional ${mode === 'files_with_matches' ? 'files' : mode === 'count' ? 'counts' : 'matches'} omitted. Continue with offset=${sliced.nextOffset} and head_limit=${headLimit}, or ${mode === 'content' ? 'read one of the returned ranges' : 'switch to output_mode=content after choosing a file'}.`;
	}
	if (mode === 'content') return 'Use read with the suggested line ranges for grounded citations.';
	if (mode === 'count') return 'Use output_mode=content after choosing a file or exact phrase.';
	return 'Use read on a matching file or switch to output_mode=content for line anchors.';
}

function formatSearchFiles(
	counts: ReturnType<typeof parseCountOutput>,
	offset: number,
	headLimit: number,
) {
	const sliced = sliceResults(counts, offset, headLimit);
	const lines = sliced.items.map((file) => file.fileName);
	if (sliced.truncated) lines.push(buildSearchHint('files_with_matches', sliced, headLimit));
	return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function formatSearchCounts(
	counts: ReturnType<typeof parseCountOutput>,
	offset: number,
	headLimit: number,
) {
	const sliced = sliceResults(counts, offset, headLimit);
	const lines = sliced.items.map((file) => `${file.fileName}: ${file.matchCount}`);
	if (sliced.truncated) lines.push(buildSearchHint('count', sliced, headLimit));
	return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function formatSearchMatches(
	matches: SearchMatchOutput[],
	sliced: { nextOffset?: number; truncated: boolean },
	headLimit: number,
) {
	const lines = matches.map(
		(match) =>
			`${match.fileName}:${match.lineNumber}:${match.text} (read ${match.readRange.start}-${match.readRange.end})`,
	);
	if (sliced.truncated) lines.push(buildSearchHint('content', sliced, headLimit));
	return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function parseGrepLine(line: string) {
	const match =
		/^(?<filePath>.*)(?<separator>[:-])(?<lineNumber>\d+)(?<contentSeparator>[:-])/.exec(line);
	if (!match?.groups) return undefined;
	return {
		filePath: normaliseGrepPath(match.groups.filePath),
		isMatch: match.groups.separator === ':' && match.groups.contentSeparator === ':',
		lineNumber: Number(match.groups.lineNumber),
		contentStartIndex: match[0].length,
	};
}

function normaliseGrepPath(filePath: string) {
	return filePath.startsWith('./') ? filePath.slice(2) : filePath;
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
