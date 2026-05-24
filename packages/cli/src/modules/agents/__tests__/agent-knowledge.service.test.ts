import { BinaryDataService } from 'n8n-core';
import { mock } from 'jest-mock-extended';

import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { AgentKnowledgeService } from '../agent-knowledge.service';
import { AgentFileRepository } from '../repositories/agent-file.repository';
import { AgentRepository } from '../repositories/agent.repository';

jest.mock('@n8n/utils', () => ({
	...jest.requireActual('@n8n/utils'),
	generateNanoId: jest.fn(() => 'file-1'),
}));

const agentId = 'agent-1';
const projectId = 'project-1';

function makeMulterFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
	return {
		fieldname: 'files',
		originalname: 'document.txt',
		encoding: '7bit',
		mimetype: 'text/plain',
		buffer: Buffer.from('hello'),
		size: 5,
		stream: null as never,
		destination: '',
		filename: '',
		path: '',
		...overrides,
	};
}

describe('AgentKnowledgeService', () => {
	let agentRepository: jest.Mocked<AgentRepository>;
	let agentFileRepository: jest.Mocked<AgentFileRepository>;
	let binaryDataService: jest.Mocked<BinaryDataService>;
	let service: AgentKnowledgeService;

	beforeEach(() => {
		agentRepository = mock<AgentRepository>();
		agentFileRepository = mock<AgentFileRepository>();
		binaryDataService = mock<BinaryDataService>();

		agentFileRepository.create.mockImplementation((data?: Partial<unknown>) => data as never);
		binaryDataService.store.mockResolvedValue({ id: 'binary-1' } as never);
		agentFileRepository.save.mockImplementation(
			async (file) =>
				({
					createdAt: new Date('2026-05-24T12:00:00.000Z'),
					...file,
				}) as never,
		);

		service = new AgentKnowledgeService(agentRepository, agentFileRepository, binaryDataService);
	});

	it('rejects files for agents outside the project', async () => {
		agentRepository.findByIdAndProjectId.mockResolvedValue(null);

		await expect(service.uploadFiles(agentId, projectId, [makeMulterFile()])).rejects.toThrow(
			NotFoundError,
		);

		expect(binaryDataService.store).not.toHaveBeenCalled();
		expect(agentFileRepository.save).not.toHaveBeenCalled();
	});

	it('rejects listing files for agents outside the project', async () => {
		agentRepository.findByIdAndProjectId.mockResolvedValue(null);

		await expect(service.listFiles(agentId, projectId)).rejects.toThrow(NotFoundError);

		expect(agentFileRepository.findByAgentId).not.toHaveBeenCalled();
	});

	it('lists file rows for the agent', async () => {
		agentRepository.findByIdAndProjectId.mockResolvedValue({ id: agentId, projectId } as never);
		agentFileRepository.findByAgentId.mockResolvedValue([
			{
				id: 'file-1',
				agentId,
				binaryDataId: 'binary-1',
				fileName: 'document.txt',
				mimeType: 'text/plain',
				fileSizeBytes: 5,
				createdAt: new Date('2026-05-24T12:00:00.000Z'),
			},
		] as never);

		await expect(service.listFiles(agentId, projectId)).resolves.toEqual([
			{
				id: 'file-1',
				agentId,
				binaryDataId: 'binary-1',
				fileName: 'document.txt',
				mimeType: 'text/plain',
				fileSizeBytes: 5,
				createdAt: '2026-05-24T12:00:00.000Z',
			},
		]);
		expect(agentFileRepository.findByAgentId).toHaveBeenCalledWith(agentId);
	});

	it('stores binary data and creates file rows for the agent', async () => {
		agentRepository.findByIdAndProjectId.mockResolvedValue({ id: agentId, projectId } as never);

		const [file] = await service.uploadFiles(agentId, projectId, [makeMulterFile()]);

		expect(binaryDataService.store).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceType: 'agent_file',
				sourceId: 'file-1',
				pathSegments: ['agents', agentId, 'files', 'file-1'],
			}),
			Buffer.from('hello'),
			expect.objectContaining({
				fileName: 'document.txt',
				mimeType: 'text/plain',
				fileSize: '5',
				bytes: 5,
			}),
		);
		expect(agentFileRepository.save).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'file-1',
				agentId,
				binaryDataId: 'binary-1',
				fileName: 'document.txt',
				mimeType: 'text/plain',
				fileSizeBytes: 5,
			}),
		);
		expect(file).toEqual({
			id: 'file-1',
			agentId,
			binaryDataId: 'binary-1',
			fileName: 'document.txt',
			mimeType: 'text/plain',
			fileSizeBytes: 5,
			createdAt: '2026-05-24T12:00:00.000Z',
		});
	});
});
