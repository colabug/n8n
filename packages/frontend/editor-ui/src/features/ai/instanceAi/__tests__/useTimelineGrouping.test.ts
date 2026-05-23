import type { InstanceAiAgentNode, InstanceAiToolCallState } from '@n8n/api-types';
import { ref } from 'vue';
import { describe, expect, test } from 'vitest';
import { useTimelineGrouping } from '../useTimelineGrouping';

function makeToolCall(overrides: Partial<InstanceAiToolCallState>): InstanceAiToolCallState {
	return {
		toolCallId: 'tc-build',
		toolName: 'workflows',
		args: { action: 'create' },
		isLoading: false,
		...overrides,
	};
}

function makeAgentNode(overrides: Partial<InstanceAiAgentNode> = {}): InstanceAiAgentNode {
	return {
		agentId: 'agent-1',
		role: 'orchestrator',
		status: 'completed',
		textContent: '',
		reasoning: '',
		toolCalls: [],
		children: [],
		timeline: [],
		...overrides,
	};
}

describe('useTimelineGrouping', () => {
	test('includes artifacts from direct workflow mutation tool calls', () => {
		const agentNode = makeAgentNode({
			toolCalls: [
				makeToolCall({
					result: { workflowId: 'wf-1', workflowName: 'Built WF' },
					completedAt: '2026-01-01T00:00:00Z',
				}),
			],
			timeline: [{ type: 'tool-call', toolCallId: 'tc-build', responseId: 'response-1' }],
		});

		const segments = useTimelineGrouping(ref(agentNode)).value;

		expect(segments).toEqual([
			expect.objectContaining({
				kind: 'response-group',
				responseId: 'response-1',
				toolCallCount: 1,
				childCount: 0,
				artifacts: [
					{
						type: 'workflow',
						resourceId: 'wf-1',
						name: 'Built WF',
						completedAt: '2026-01-01T00:00:00Z',
					},
				],
			}),
		]);
	});

	test('keeps artifact-only groups for special builder tool calls', () => {
		const agentNode = makeAgentNode({
			toolCalls: [
				makeToolCall({
					renderHint: 'builder',
					result: { workflowId: 'wf-2', workflowName: 'Hidden Builder WF' },
				}),
			],
			timeline: [{ type: 'tool-call', toolCallId: 'tc-build', responseId: 'response-1' }],
		});

		const segments = useTimelineGrouping(ref(agentNode)).value;

		expect(segments).toHaveLength(1);
		expect(segments?.[0]).toEqual(
			expect.objectContaining({
				kind: 'response-group',
				toolCallCount: 0,
				artifacts: [
					expect.objectContaining({
						type: 'workflow',
						resourceId: 'wf-2',
						name: 'Hidden Builder WF',
					}),
				],
			}),
		);
	});
});
