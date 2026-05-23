<script lang="ts" setup>
import type {
	InstanceAiAgentNode,
	InstanceAiTimelineEntry,
	InstanceAiToolCallState,
	TaskList,
} from '@n8n/api-types';
import { N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';
import { extractArtifacts, HIDDEN_TOOLS, type ArtifactInfo } from '../agentTimeline.utils';
import { useTelemetry } from '@/app/composables/useTelemetry';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useThread } from '../instanceAi.store';
import { isActiveBuilderAgent } from '../builderAgents';
import AgentSection from './AgentSection.vue';
import AnsweredQuestions from './AnsweredQuestions.vue';
import ArtifactCard from './ArtifactCard.vue';
import DelegateCard from './DelegateCard.vue';
import InstanceAiMarkdown from './InstanceAiMarkdown.vue';
import PlanReviewPanel, { type PlannedTaskArg } from './PlanReviewPanel.vue';
import TaskChecklist from './TaskChecklist.vue';
import ToolCallStep from './ToolCallStep.vue';

const i18n = useI18n();
const thread = useThread();
const telemetry = useTelemetry();
const rootStore = useRootStore();

/** Resolve artifact name from the enriched registry (falls back to extracted name). */
function resolveArtifactName(artifact: ArtifactInfo): string {
	const entry = thread.producedArtifacts.get(artifact.resourceId);
	return entry?.name ?? artifact.name;
}

function formatRelativeTime(isoTime: string): string {
	const diffMs = Date.now() - new Date(isoTime).getTime();
	const diffMin = Math.floor(diffMs / 60_000);
	if (diffMin < 1) {
		return i18n.baseText('instanceAi.artifactCard.updatedJustNow');
	}
	const diffHours = Math.floor(diffMin / 60);
	if (diffHours < 1) {
		const key =
			diffMin === 1 ? 'instanceAi.artifactCard.minute' : 'instanceAi.artifactCard.minutes';
		const time = i18n.baseText(key, {
			interpolate: { count: `${diffMin}` },
		});
		return i18n.baseText('instanceAi.artifactCard.updatedAgo', { interpolate: { time } });
	}
	const key = diffHours === 1 ? 'instanceAi.artifactCard.hour' : 'instanceAi.artifactCard.hours';
	const time = i18n.baseText(key, {
		interpolate: { count: `${diffHours}` },
	});
	return i18n.baseText('instanceAi.artifactCard.updatedAgo', { interpolate: { time } });
}

function formatCreatedDate(isoTime: string): string {
	const date = new Date(isoTime);
	const day = date.getDate();
	const month = date.toLocaleString('en', { month: 'long' });
	return i18n.baseText('instanceAi.artifactCard.createdAt', {
		interpolate: { date: `${day} ${month}` },
	});
}

function formatArtifactMetadata(artifact: ArtifactInfo): string {
	const parts: string[] = [];

	if (artifact.completedAt) {
		parts.push(formatRelativeTime(artifact.completedAt));
		parts.push(formatCreatedDate(artifact.completedAt));
	} else {
		parts.push(i18n.baseText('instanceAi.artifactCard.updatedJustNow'));
	}

	return parts.join(' \u2502 ');
}

const props = withDefaults(
	defineProps<{
		agentNode: InstanceAiAgentNode;
		compact?: boolean;
		/** When provided, renders only these entries instead of the full timeline. */
		visibleEntries?: InstanceAiTimelineEntry[];
	}>(),
	{
		compact: false,
		visibleEntries: undefined,
	},
);

const timelineEntries = computed(() => props.visibleEntries ?? props.agentNode.timeline);

defineSlots<{
	'after-tool-call'?: (props: { toolCall: InstanceAiToolCallState }) => unknown;
}>();

/** Index tool calls by ID for O(1) lookup and proper reactivity tracking. */
const toolCallsById = computed(() => {
	const map: Record<string, InstanceAiToolCallState> = {};
	for (const tc of props.agentNode.toolCalls) {
		map[tc.toolCallId] = tc;
	}
	return map;
});

/** Index children by agentId for O(1) lookup and proper reactivity tracking. */
const childrenById = computed(() => {
	const map: Record<string, InstanceAiAgentNode> = {};
	for (const child of props.agentNode.children) {
		map[child.agentId] = child;
	}
	return map;
});

function handlePlanConfirm(tc: InstanceAiToolCallState, approved: boolean, feedback?: string) {
	const requestId = tc.confirmation?.requestId;
	if (!requestId) return;

	const numTasks = ((tc.args?.tasks as PlannedTaskArg[] | undefined) ?? []).length;
	const eventProps = {
		thread_id: thread.id,
		input_thread_id: tc.confirmation?.inputThreadId ?? '',
		instance_id: rootStore.instanceId,
		type: 'plan-review',
		provided_inputs: [
			{
				label: 'plan',
				options: ['approve', 'request-changes', 'deny'],
				option_chosen: approved ? 'approve' : 'request-changes',
			},
		],
		skipped_inputs: [],
		num_tasks: numTasks,
		...(feedback ? { feedback } : {}),
	};
	telemetry.track('User finished providing input', eventProps);

	thread.resolveConfirmation(requestId, approved ? 'approved' : 'denied');
	void thread.confirmAction(requestId, {
		kind: 'approval',
		approved,
		...(feedback ? { userInput: feedback } : {}),
	});
}

/** PlanReviewPanel is read-only when its tool call has settled OR when the
 *  underlying confirmation has already been resolved client-side. Without the
 *  resolvedConfirmationIds check, a freshly-loading new plan tool call could
 *  briefly re-enable the old card's footer (toolCall.isLoading flips back to
 *  true on tool-call-start before the previous card's read-only catches up). */
function isPlanCardReadOnly(tc: InstanceAiToolCallState): boolean {
	if (!tc.isLoading) return true;
	const requestId = tc.confirmation?.requestId;
	if (requestId && thread.resolvedConfirmationIds.has(requestId)) return true;
	return false;
}

function handlePlanDeny(tc: InstanceAiToolCallState) {
	const requestId = tc.confirmation?.requestId;
	if (!requestId) return;

	const numTasks = ((tc.args?.tasks as PlannedTaskArg[] | undefined) ?? []).length;
	telemetry.track('User finished providing input', {
		thread_id: thread.id,
		input_thread_id: tc.confirmation?.inputThreadId ?? '',
		instance_id: rootStore.instanceId,
		type: 'plan-review',
		provided_inputs: [
			{
				label: 'plan',
				options: ['approve', 'request-changes', 'deny'],
				option_chosen: 'deny',
			},
		],
		skipped_inputs: [],
		num_tasks: numTasks,
	});

	thread.resolveConfirmation(requestId, 'denied');
	void thread.confirmAction(requestId, { kind: 'planDeny' });
}

/** Plan-review confirmation on the orchestrator's `plan` tool call. The cascade
 *  flow attaches it here (the planner sub-agent's submit-plan confirmation
 *  event is captured-not-published, so it never reaches the tree). */
const planToolConfirmation = computed<InstanceAiToolCallState | undefined>(() =>
	props.agentNode.toolCalls.find((tc) => tc.confirmation?.inputType === 'plan-review'),
);

/** True when a planner sub-agent has been spawned for this orchestrator turn.
 *  When present we defer the plan card render to the post-AgentSection slot so
 *  the planner's collapsed step list appears above the plan card. */
const hasPlannerChild = computed<boolean>(() =>
	props.agentNode.children.some((c) => c.role === 'planner'),
);

/** Map simplified TaskList items to PlannedTaskArg shape for loading preview */
function mapTaskItemsToPlannedTasks(tasks?: TaskList): PlannedTaskArg[] | undefined {
	if (!tasks?.tasks?.length) return undefined;
	return tasks.tasks.map((t) => ({
		id: t.id,
		title: t.description,
		kind: '',
		spec: '',
		deps: [],
	}));
}
</script>

<template>
	<div :class="$style.timeline">
		<template v-for="(entry, idx) in timelineEntries" :key="idx">
			<!-- Text segment -->
			<N8nText
				v-if="entry.type === 'text'"
				size="large"
				:compact="props.compact"
				:class="$style.timelineItem"
			>
				<InstanceAiMarkdown :content="entry.content" />
			</N8nText>

			<!-- Tool call (skip internal tools like updateWorkingMemory) -->
			<template
				v-else-if="
					entry.type === 'tool-call' &&
					toolCallsById[entry.toolCallId] &&
					!HIDDEN_TOOLS.has(toolCallsById[entry.toolCallId].toolName)
				"
			>
				<TaskChecklist
					v-if="toolCallsById[entry.toolCallId].renderHint === 'tasks'"
					:tasks="props.agentNode.tasks"
				/>
				<DelegateCard
					v-else-if="toolCallsById[entry.toolCallId].renderHint === 'delegate'"
					:args="toolCallsById[entry.toolCallId].args"
					:result="toolCallsById[entry.toolCallId].result"
					:is-loading="toolCallsById[entry.toolCallId].isLoading"
					:tool-call-id="toolCallsById[entry.toolCallId].toolCallId"
				/>
				<!-- Hidden tool calls (builder/data-table/researcher/eval-setup handled by child agent via AgentSection) -->
				<template v-else-if="toolCallsById[entry.toolCallId].renderHint === 'builder'" />
				<template v-else-if="toolCallsById[entry.toolCallId].renderHint === 'data-table'" />
				<template v-else-if="toolCallsById[entry.toolCallId].renderHint === 'researcher'" />
				<template v-else-if="toolCallsById[entry.toolCallId].renderHint === 'eval-setup'" />
				<!-- Plan review fallback for the edge case where the plan tool carries
				     the cascaded confirmation but no planner child agent was spawned
				     (e.g. the planner errored before agent-spawned). When a planner
				     child does exist we defer to the post-AgentSection slot below so
				     the collapsed step list renders above the plan card. -->
				<PlanReviewPanel
					v-else-if="
						toolCallsById[entry.toolCallId].confirmation?.inputType === 'plan-review' &&
						!hasPlannerChild
					"
					:key="toolCallsById[entry.toolCallId].confirmation?.requestId"
					:planned-tasks="
						toolCallsById[entry.toolCallId].confirmation?.planItems ??
						(toolCallsById[entry.toolCallId].args?.tasks as PlannedTaskArg[] | undefined) ??
						mapTaskItemsToPlannedTasks(toolCallsById[entry.toolCallId].confirmation?.tasks) ??
						[]
					"
					:read-only="isPlanCardReadOnly(toolCallsById[entry.toolCallId])"
					@approve="handlePlanConfirm(toolCallsById[entry.toolCallId], true)"
					@request-changes="(fb) => handlePlanConfirm(toolCallsById[entry.toolCallId], false, fb)"
					@deny="handlePlanDeny(toolCallsById[entry.toolCallId])"
				/>
				<!-- Planner: suppress tool call — PlanReviewPanel renders after the child AgentSection -->
				<template v-else-if="toolCallsById[entry.toolCallId].renderHint === 'planner'" />
				<!-- Answered questions (read-only after resolution) -->
				<AnsweredQuestions
					v-else-if="
						toolCallsById[entry.toolCallId].confirmation?.inputType === 'questions' &&
						!toolCallsById[entry.toolCallId].isLoading
					"
					:tool-call="toolCallsById[entry.toolCallId]"
				/>
				<!-- Suppress default tool call while questions are pending -->
				<template
					v-else-if="
						toolCallsById[entry.toolCallId].confirmation?.inputType === 'questions' &&
						toolCallsById[entry.toolCallId].isLoading
					"
				/>
				<ToolCallStep v-else :tool-call="toolCallsById[entry.toolCallId]" :show-connector="true">
					<slot name="after-tool-call" :tool-call="toolCallsById[entry.toolCallId]" />
				</ToolCallStep>
			</template>

			<!-- Child agent — flat section. Running builder sub-agents are
				 extracted and rendered at the bottom of the conversation by
				 InstanceAiView; once a builder finishes it reappears here in its
				 chronological slot. -->
			<template
				v-else-if="
					entry.type === 'child' &&
					childrenById[entry.agentId] &&
					!isActiveBuilderAgent(childrenById[entry.agentId])
				"
			>
				<AgentSection :agent-node="childrenById[entry.agentId]" />

				<!-- Planner child: render PlanReviewPanel below the agent section once
				     the cascaded confirmation arrives on the orchestrator's plan tool.
				     Before that (while the planner is still adding items) we render a
				     loading preview seeded from the orchestrator's accumulated
				     planItems/tasks. -->
				<PlanReviewPanel
					v-if="
						childrenById[entry.agentId].role === 'planner' &&
						(planToolConfirmation ||
							props.agentNode.planItems?.length ||
							props.agentNode.tasks?.tasks?.length)
					"
					:key="planToolConfirmation?.confirmation?.requestId ?? 'plan-loading'"
					:planned-tasks="
						planToolConfirmation?.confirmation?.planItems ??
						(props.agentNode.planItems as PlannedTaskArg[] | undefined) ??
						mapTaskItemsToPlannedTasks(props.agentNode.tasks) ??
						[]
					"
					:loading="!planToolConfirmation"
					:read-only="!!planToolConfirmation && !planToolConfirmation.isLoading"
					@approve="planToolConfirmation && handlePlanConfirm(planToolConfirmation, true)"
					@request-changes="
						(fb) => planToolConfirmation && handlePlanConfirm(planToolConfirmation, false, fb)
					"
					@deny="planToolConfirmation && handlePlanDeny(planToolConfirmation)"
				/>

				<!-- Artifact cards for completed subagents (skip when inside grouped view) -->
				<template v-if="!props.visibleEntries">
					<ArtifactCard
						v-for="artifact in extractArtifacts(childrenById[entry.agentId])"
						:key="artifact.resourceId"
						:type="artifact.type"
						:name="resolveArtifactName(artifact)"
						:resource-id="artifact.resourceId"
						:project-id="artifact.projectId"
						:archived="thread.producedArtifacts.get(artifact.resourceId)?.archived"
						:metadata="formatArtifactMetadata(artifact)"
					/>
				</template>
			</template>
		</template>
	</div>
</template>

<style lang="scss" module>
.timeline {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.timelineItem {
	max-width: 90%;
}
</style>
