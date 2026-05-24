const INTERNAL_BLOCK_NAMES =
	'planning-blueprint|planned-task-follow-up|background-task-completed|running-tasks';

const COMPLETE_INTERNAL_BLOCK_PATTERN = new RegExp(
	`<(${INTERNAL_BLOCK_NAMES})[\\s\\S]*?<\\/\\1>`,
	'g',
);

const TRAILING_INTERNAL_BLOCK_PATTERN = new RegExp(`<(?:${INTERNAL_BLOCK_NAMES})\\b[\\s\\S]*$`);

export function stripInternalInstanceAiBlocks(content: string): string {
	return content
		.replace(COMPLETE_INTERNAL_BLOCK_PATTERN, '')
		.replace(TRAILING_INTERNAL_BLOCK_PATTERN, '')
		.trim();
}
