import { NodeConnectionTypes } from 'n8n-workflow';

import { Pokemon } from '../Pokemon.node';

describe('Pokemon Node — Cycle 1: description', () => {
	let node: Pokemon;

	beforeEach(() => {
		node = new Pokemon();
	});

	it('should have correct displayName', () => {
		expect(node.description.displayName).toBe('Pokemon');
	});

	it('should have correct name', () => {
		expect(node.description.name).toBe('pokemon');
	});

	it('should have correct icon', () => {
		expect(node.description.icon).toBe('file:pokemon.svg');
	});

	it('should have group set to input', () => {
		expect(node.description.group).toEqual(['input']);
	});

	it('should have version 1', () => {
		expect(node.description.version).toBe(1);
	});

	it('should have usableAsTool true', () => {
		expect(node.description.usableAsTool).toBe(true);
	});

	it('should have correct subtitle', () => {
		expect(node.description.subtitle).toBe('={{$parameter["operation"] + ": Pokemon"}}');
	});

	it('should have a description mentioning both operations', () => {
		expect(node.description.description).toContain('Get');
		expect(node.description.description).toContain('Get Many');
	});

	it('should have Main input and output', () => {
		expect(node.description.inputs).toEqual([NodeConnectionTypes.Main]);
		expect(node.description.outputs).toEqual([NodeConnectionTypes.Main]);
	});

	it('should have operation property with get and getAll options', () => {
		const operationProp = node.description.properties.find((p) => p.name === 'operation');
		expect(operationProp).toBeDefined();
		expect(operationProp?.type).toBe('options');
		const options = operationProp?.options as Array<{
			value: string;
			name: string;
			action: string;
		}>;
		const values = options.map((o) => o.value);
		expect(values).toContain('get');
		expect(values).toContain('getAll');
	});

	it('should have action strings on operations', () => {
		const operationProp = node.description.properties.find((p) => p.name === 'operation');
		const options = operationProp?.options as Array<{
			value: string;
			name: string;
			action: string;
		}>;
		const get = options.find((o) => o.value === 'get');
		const getAll = options.find((o) => o.value === 'getAll');
		expect(get?.action).toBeTruthy();
		expect(getAll?.action).toBeTruthy();
	});

	it('should have nameOrId field shown only for get operation', () => {
		const nameOrId = node.description.properties.find((p) => p.name === 'nameOrId');
		expect(nameOrId).toBeDefined();
		expect(nameOrId?.displayOptions?.show?.operation).toContain('get');
	});

	it('should have returnAll field shown only for getAll operation', () => {
		const returnAll = node.description.properties.find((p) => p.name === 'returnAll');
		expect(returnAll).toBeDefined();
		expect(returnAll?.displayOptions?.show?.operation).toContain('getAll');
	});

	it('should have limit field shown only for getAll when returnAll is false', () => {
		const limit = node.description.properties.find((p) => p.name === 'limit');
		expect(limit).toBeDefined();
		expect(limit?.displayOptions?.show?.operation).toContain('getAll');
		expect(limit?.displayOptions?.show?.returnAll).toContain(false);
	});

	it('should have simplify field shown only for get operation', () => {
		const simplify = node.description.properties.find((p) => p.name === 'simplify');
		expect(simplify).toBeDefined();
		expect(simplify?.displayOptions?.show?.operation).toContain('get');
		const showOps = simplify?.displayOptions?.show?.operation as string[];
		expect(showOps).not.toContain('getAll');
	});
});
