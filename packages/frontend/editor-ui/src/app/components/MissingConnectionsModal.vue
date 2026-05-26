<script setup lang="ts">
import { computed } from 'vue';

import Modal from '@/app/components/Modal.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { useI18n } from '@n8n/i18n';
import { MISSING_CONNECTIONS_MODAL_KEY } from '../constants';

import { N8nButton, N8nText } from '@n8n/design-system';

type MissingCredential = {
	id: string;
	name: string;
	nodeNames: string[];
};

const uiStore = useUIStore();
const i18n = useI18n();

const missingCredentials = computed<MissingCredential[]>(() => {
	const data = uiStore.modalsById[MISSING_CONNECTIONS_MODAL_KEY]?.data as
		| { missingCredentials?: MissingCredential[] }
		| undefined;
	return data?.missingCredentials ?? [];
});
</script>

<template>
	<Modal
		:name="MISSING_CONNECTIONS_MODAL_KEY"
		:title="i18n.baseText('missingConnectionsModal.title')"
		width="460px"
	>
		<template #content>
			<div :class="$style.intro">
				<N8nText>{{ i18n.baseText('missingConnectionsModal.description') }}</N8nText>
			</div>
			<ul :class="$style.list">
				<li v-for="cred in missingCredentials" :key="cred.id" :class="$style.item">
					<N8nText :bold="true">{{ cred.name }}</N8nText>
					<N8nText size="small" color="text-light">
						{{
							i18n.baseText('missingConnectionsModal.usedBy', {
								interpolate: { nodes: cred.nodeNames.join(', ') },
							})
						}}
					</N8nText>
				</li>
			</ul>
		</template>

		<template #footer="{ close }">
			<div :class="$style.footer">
				<N8nButton :label="i18n.baseText('missingConnectionsModal.gotIt')" @click="close" />
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.intro {
	margin-bottom: var(--spacing--sm);
}

.list {
	list-style: none;
	padding: 0;
	margin: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.item {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--5xs);
	padding: var(--spacing--2xs) var(--spacing--xs);
	border: var(--border);
	border-radius: var(--radius);
}

.footer {
	display: flex;
	justify-content: flex-end;
	align-items: center;
}
</style>
