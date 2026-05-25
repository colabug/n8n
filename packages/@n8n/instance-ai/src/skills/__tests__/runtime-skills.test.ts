import { createSkillLoadTool } from '@n8n/agents';
import { existsSync } from 'node:fs';

import { INSTANCE_AI_SKILLS_DIR, loadInstanceAiRuntimeSkillSource } from '../runtime-skills';

describe('Instance AI runtime skills', () => {
	it('loads the bundled data-table-manager skill and its linked files', async () => {
		expect(existsSync(INSTANCE_AI_SKILLS_DIR)).toBe(true);

		const source = loadInstanceAiRuntimeSkillSource();
		const dataTableManager = source.registry.skills.find(
			(skill) => skill.name === 'data-table-manager',
		);

		expect(dataTableManager).toMatchObject({
			name: 'data-table-manager',
			description:
				'Designs and manages n8n Data Tables directly with the data-tables and parse-file tools. Use when the user asks to create, inspect, import, seed, query, update, clean up, rename columns in, or delete data tables and rows, especially from CSV/XLSX/JSON attachments.',
			platforms: ['daytona'],
			recommendedTools: ['data-tables', 'parse-file'],
		});
		expect(dataTableManager?.linkedFiles.references).toEqual([
			expect.objectContaining({ path: 'references/data-table-playbook.md' }),
		]);
		expect(dataTableManager?.linkedFiles.scripts).toEqual([]);

		const loadTool = createSkillLoadTool(source);
		const loadResult = await loadTool.handler?.(
			{ skillId: 'data-table-manager', filePath: 'references/data-table-playbook.md' },
			{},
		);
		expect(loadResult).toMatchObject({
			success: true,
			skillId: 'data-table-manager',
			name: 'data-table-manager',
			filePath: 'references/data-table-playbook.md',
		});
		if (
			!loadResult ||
			typeof loadResult !== 'object' ||
			!('content' in loadResult) ||
			typeof loadResult.content !== 'string'
		) {
			throw new Error('Expected load_skill to return file content');
		}
		expect(loadResult.content).toContain('Fast Routing');
	});

	it('loads the bundled workflow-builder skill', async () => {
		const source = loadInstanceAiRuntimeSkillSource();
		const workflowBuilder = source.registry.skills.find(
			(skill) => skill.name === 'workflow-builder',
		);

		expect(workflowBuilder).toMatchObject({
			name: 'workflow-builder',
			description:
				'Builds and edits n8n workflows directly with the workflow SDK and the workflows tool. Use for existing-workflow edits, fixes, node rewiring, credential-preserving patches, verification, setup routing, and workflow creation only inside approved planned build follow-up turns.',
			platforms: ['daytona'],
			recommendedTools: [
				'workflows',
				'verify-built-workflow',
				'executions',
				'credentials',
				'nodes',
				'data-tables',
				'parse-file',
				'ask-user',
			],
		});

		const loadTool = createSkillLoadTool(source);
		const loadResult = await loadTool.handler?.({ skillId: 'workflow-builder' }, {});
		expect(loadResult).toMatchObject({
			success: true,
			skillId: 'workflow-builder',
			name: 'workflow-builder',
		});
		if (
			!loadResult ||
			typeof loadResult !== 'object' ||
			!('content' in loadResult) ||
			typeof loadResult.content !== 'string'
		) {
			throw new Error('Expected load_skill to return workflow-builder content');
		}
		expect(loadResult.content).toContain('Do not use web search to learn workflow SDK syntax');
		expect(loadResult.content).toContain(
			'This skill replaces the old detached workflow-builder agent',
		);
		expect(loadResult.content).toContain('Trace data shape, not just node existence');
		expect(loadResult.content).toContain('The canonical workflow-building lifecycle');
		expect(loadResult.content).toContain('Verify with tool evidence, not builder prose');
		expect(loadResult.content).toContain('Publish only when the user explicitly asks');
		expect(loadResult.content).toContain('Prefer `workflows(action="update")` patch mode');
		expect(loadResult.content).toContain('Do not use `workflows(action="update-json")`');
		expect(loadResult.content).toContain(
			"workflow('example-workflow', 'Example Workflow').add(startTrigger).to(setFields)",
		);
	});
});
