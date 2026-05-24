import type { InstanceAiMessage } from '@n8n/api-types';
import { describe, expect, it } from 'vitest';

import { messageHasVisibleContent } from '../messageVisibility';

function assistantMessage(content: string): InstanceAiMessage {
	return {
		id: 'msg-1',
		role: 'assistant',
		content,
		isStreaming: false,
		agentTree: null,
	} as InstanceAiMessage;
}

describe('messageHasVisibleContent', () => {
	it('hides assistant messages that only contain internal blocks', () => {
		expect(
			messageHasVisibleContent(
				assistantMessage('<running-tasks><task id="1">Build</task></running-tasks>'),
			),
		).toBe(false);
	});

	it('keeps assistant messages with text outside internal blocks visible', () => {
		expect(
			messageHasVisibleContent(
				assistantMessage(
					'Done.\n<background-task-completed>{"id":"task-1"}</background-task-completed>',
				),
			),
		).toBe(true);
	});
});
