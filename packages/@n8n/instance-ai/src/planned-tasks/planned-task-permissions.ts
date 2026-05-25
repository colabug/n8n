import type { InstanceAiPermissions } from '@n8n/api-types';

import type { InstanceAiContext, PlannedTaskKind } from '../types';

interface PlannedTaskPermissionOptions {
	plannedBuild?: {
		workflowId?: string;
	};
}

/**
 * Permission overrides applied when a planned task has been approved by the user.
 *
 * Plan approval acts as authorization for the task-family's non-destructive tools,
 * so the planned-task executor can run without a second confirmation prompt.
 *
 * Destructive actions, open-ended actions (fetch-url, read-file),
 * and credential deletion are intentionally excluded — they always require explicit approval.
 */
export const PLANNED_TASK_PERMISSION_OVERRIDES: Partial<
	Record<PlannedTaskKind, Partial<InstanceAiPermissions>>
> = {
	'build-workflow': {
		createDataTable: 'always_allow',
		mutateDataTableSchema: 'always_allow',
		mutateDataTableRows: 'always_allow',
	},
	// Checkpoint tasks run inside an orchestrator follow-up run. Plan approval
	// authorizes the verification step, so the orchestrator can call
	// verify-built-workflow / executions(action="run") without a second prompt.
	checkpoint: {
		runWorkflow: 'always_allow',
		updateWorkflow: 'always_allow',
	},
};

export function getPlannedTaskPermissionOverrides(
	taskKind: PlannedTaskKind,
	options: PlannedTaskPermissionOptions = {},
): Partial<InstanceAiPermissions> | undefined {
	const baseOverrides = PLANNED_TASK_PERMISSION_OVERRIDES[taskKind];
	if (taskKind !== 'build-workflow' || !options.plannedBuild) {
		return baseOverrides ? { ...baseOverrides } : undefined;
	}

	return {
		...(baseOverrides ?? {}),
		...(options.plannedBuild.workflowId
			? { updateWorkflow: 'always_allow' as const }
			: { createWorkflow: 'always_allow' as const }),
	};
}

/**
 * Returns a shallow clone of the context with plan-approved permission overrides
 * applied for the given task kind. If no overrides exist for the kind, the
 * original context is returned unchanged.
 */
export function applyPlannedTaskPermissions(
	context: InstanceAiContext,
	taskKind: PlannedTaskKind,
	options?: PlannedTaskPermissionOptions,
): InstanceAiContext {
	const overrides = getPlannedTaskPermissionOverrides(taskKind, options);
	if (!overrides) return context;

	return {
		...context,
		permissions: {
			...context.permissions,
			...overrides,
		} as InstanceAiPermissions,
	};
}
