<script setup lang="ts">
import { computed, useTemplateRef } from 'vue';
import {
	N8nActionBox,
	N8nCard,
	N8nIcon,
	N8nIconButton,
	N8nLoading,
	N8nScrollArea,
	N8nText,
	N8nTooltip,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { AgentFileDto } from '@n8n/api-types';

import AgentPanelHeader from './AgentPanelHeader.vue';

const props = withDefaults(
	defineProps<{
		files: AgentFileDto[];
		disabled?: boolean;
		loading?: boolean;
		uploading?: boolean;
	}>(),
	{
		disabled: false,
		loading: false,
		uploading: false,
	},
);

const emit = defineEmits<{
	'upload-files': [files: File[]];
}>();

const i18n = useI18n();
const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const totalCount = computed(() => props.files.length);
const isUploadDisabled = computed(() => props.disabled || props.loading || props.uploading);

function formatFileSize(bytes: number) {
	if (bytes < 1024)
		return i18n.baseText('agents.builder.files.size.bytes', { interpolate: { bytes } });
	const kilobytes = bytes / 1024;
	if (kilobytes < 1024) {
		return i18n.baseText('agents.builder.files.size.kilobytes', {
			interpolate: { kilobytes: kilobytes.toFixed(1) },
		});
	}
	const megabytes = kilobytes / 1024;
	return i18n.baseText('agents.builder.files.size.megabytes', {
		interpolate: { megabytes: megabytes.toFixed(1) },
	});
}

function openFilePicker() {
	if (isUploadDisabled.value) return;
	fileInput.value?.click();
}

function onFilesSelected(event: Event) {
	const input = event.target;
	if (!(input instanceof HTMLInputElement)) return;
	const selectedFiles = Array.from(input.files ?? []);
	input.value = '';
	if (selectedFiles.length === 0) return;

	emit('upload-files', selectedFiles);
}
</script>

<template>
	<div :class="[$style.panel, props.disabled && $style.disabled]" data-testid="agent-files-panel">
		<AgentPanelHeader
			:class="$style.header"
			:title="i18n.baseText('agents.builder.files.title')"
			:description="
				i18n.baseText('agents.builder.files.count', {
					adjustToNumber: totalCount,
					interpolate: { count: String(totalCount) },
				})
			"
		>
			<template #actions>
				<N8nTooltip :content="i18n.baseText('agents.builder.files.upload')" placement="top">
					<N8nIconButton
						icon="plus"
						variant="solid"
						size="small"
						:disabled="isUploadDisabled"
						:aria-label="i18n.baseText('agents.builder.files.upload')"
						data-testid="agent-files-upload"
						@click="openFilePicker"
					/>
				</N8nTooltip>
			</template>
		</AgentPanelHeader>

		<input
			ref="fileInput"
			type="file"
			accept=".pdf,.md,.markdown,.txt,.csv"
			multiple
			:class="$style.fileInput"
			data-testid="agent-files-upload-input"
			@change="onFilesSelected"
		/>

		<N8nLoading v-if="props.loading" :rows="2" variant="p" />

		<N8nActionBox
			v-else-if="totalCount === 0"
			:class="$style.empty"
			:icon="{ type: 'icon', value: 'file-text' }"
			:description="i18n.baseText('agents.builder.files.empty')"
		/>

		<N8nScrollArea
			v-else
			max-height="calc((var(--spacing--2xl) + var(--spacing--sm)) * 5)"
			type="auto"
			:class="$style.rows"
		>
			<div :class="$style.rowList">
				<N8nCard
					v-for="file in props.files"
					:key="file.id"
					:class="$style.row"
					data-testid="agent-files-list-row"
				>
					<template #prepend>
						<N8nIcon icon="file-text" :size="14" :class="$style.fileIcon" />
					</template>

					<N8nText size="small" color="text-dark" :class="$style.name">
						{{ file.fileName }}
					</N8nText>
					<N8nText size="small" color="text-light" :class="$style.metadata">
						{{ file.mimeType }} · {{ formatFileSize(file.fileSizeBytes) }}
					</N8nText>
				</N8nCard>
			</div>
		</N8nScrollArea>
	</div>
</template>

<style module lang="scss">
.panel {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	width: 100%;
}

.panel.disabled > :not(.header) {
	pointer-events: none;
	opacity: 0.6;
}

.fileInput {
	display: none;
}

.empty {
	padding: var(--spacing--lg);
}

.rowList {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.row {
	--card--append--width: auto;
	flex-shrink: 0;
}

.fileIcon {
	flex-shrink: 0;
	color: var(--text-color--subtle);
}

.name {
	font-weight: var(--font-weight--medium);
	margin-bottom: var(--spacing--4xs);
}

.name,
.metadata {
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: var(--font-size--xs);
	line-height: var(--line-height--md);
	max-width: 80%;
}
</style>
