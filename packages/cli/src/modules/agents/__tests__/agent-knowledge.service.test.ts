import type { BinaryDataService } from 'n8n-core';
import { mock } from 'jest-mock-extended';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { AgentKnowledgeService } from '../agent-knowledge.service';
import type { AgentFileRepository } from '../repositories/agent-file.repository';
import type { AgentRepository } from '../repositories/agent.repository';

jest.unmock('node:fs/promises');

const mockGetText = jest.fn<Promise<{ text: string; total: number }>, []>();
const mockDestroy = jest.fn<Promise<void>, []>();

jest.mock('pdf-parse', () => ({
	__esModule: true,
	PDFParse: jest.fn().mockImplementation(() => ({
		getText: mockGetText,
		destroy: mockDestroy,
	})),
}));

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
		binaryDataService.getAsBuffer.mockResolvedValue(Buffer.from('stored text'));
		mockGetText.mockReset();
		mockDestroy.mockReset().mockResolvedValue(undefined);

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

	it('rejects deleting files for agents outside the project', async () => {
		agentRepository.findByIdAndProjectId.mockResolvedValue(null);

		await expect(service.deleteFile(agentId, projectId, 'file-1')).rejects.toThrow(NotFoundError);

		expect(agentFileRepository.findByIdAndAgentId).not.toHaveBeenCalled();
		expect(binaryDataService.deleteManyByBinaryDataId).not.toHaveBeenCalled();
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

	it('deletes the file row and stored binary data for the agent', async () => {
		agentRepository.findByIdAndProjectId.mockResolvedValue({ id: agentId, projectId } as never);
		agentFileRepository.findByIdAndAgentId.mockResolvedValue({
			id: 'file-1',
			agentId,
			binaryDataId: 'binary-1',
			fileName: 'document.txt',
			mimeType: 'text/plain',
			fileSizeBytes: 5,
			createdAt: new Date('2026-05-24T12:00:00.000Z'),
		} as never);

		await service.deleteFile(agentId, projectId, 'file-1');

		expect(agentFileRepository.delete).toHaveBeenCalledWith({ id: 'file-1', agentId });
		expect(binaryDataService.deleteManyByBinaryDataId).toHaveBeenCalledWith(['binary-1']);
	});

	it('rejects deleting files that are not attached to the agent', async () => {
		agentRepository.findByIdAndProjectId.mockResolvedValue({ id: agentId, projectId } as never);
		agentFileRepository.findByIdAndAgentId.mockResolvedValue(null);

		await expect(service.deleteFile(agentId, projectId, 'file-1')).rejects.toThrow(NotFoundError);

		expect(agentFileRepository.delete).not.toHaveBeenCalled();
		expect(binaryDataService.deleteManyByBinaryDataId).not.toHaveBeenCalled();
	});

	it('stores extracted PDF text as the binary payload while preserving the PDF filename', async () => {
		agentRepository.findByIdAndProjectId.mockResolvedValue({ id: agentId, projectId } as never);
		mockGetText.mockResolvedValue({ text: 'Extracted PDF text', total: 1 });

		const [file] = await service.uploadFiles(agentId, projectId, [
			makeMulterFile({
				originalname: 'document.pdf',
				mimetype: 'application/pdf',
				buffer: Buffer.from('%PDF original bytes'),
				size: 19,
			}),
		]);

		expect(binaryDataService.store).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceType: 'agent_file',
				sourceId: 'file-1',
			}),
			Buffer.from('Extracted PDF text', 'utf8'),
			expect.objectContaining({
				fileName: 'document.pdf.txt',
				mimeType: 'text/plain',
				fileSize: '18',
				bytes: 18,
				fileExtension: 'txt',
			}),
		);
		expect(agentFileRepository.save).toHaveBeenCalledWith(
			expect.objectContaining({
				fileName: 'document.pdf',
				mimeType: 'text/plain',
				fileSizeBytes: 19,
			}),
		);
		expect(file).toMatchObject({
			fileName: 'document.pdf',
			mimeType: 'text/plain',
			fileSizeBytes: 19,
		});
		expect(mockDestroy).toHaveBeenCalledTimes(1);
	});

	it('rejects PDFs with no extractable text', async () => {
		agentRepository.findByIdAndProjectId.mockResolvedValue({ id: agentId, projectId } as never);
		mockGetText.mockResolvedValue({ text: '   ', total: 1 });

		await expect(
			service.uploadFiles(agentId, projectId, [
				makeMulterFile({
					originalname: 'empty.pdf',
					mimetype: 'application/pdf',
					buffer: Buffer.from('%PDF original bytes'),
				}),
			]),
		).rejects.toThrow(BadRequestError);

		expect(binaryDataService.store).not.toHaveBeenCalled();
		expect(agentFileRepository.save).not.toHaveBeenCalled();
		expect(mockDestroy).toHaveBeenCalledTimes(1);
	});

	it('materializes stored PDF text as a searchable text file', async () => {
		agentRepository.findByIdAndProjectId.mockResolvedValue({ id: agentId, projectId } as never);
		agentFileRepository.findByAgentId.mockResolvedValue([
			{
				id: 'file-1',
				agentId,
				binaryDataId: 'binary-1',
				fileName: 'document.pdf',
				mimeType: 'text/plain',
				fileSizeBytes: 19,
				createdAt: new Date('2026-05-24T12:00:00.000Z'),
			},
		] as never);
		binaryDataService.getAsBuffer.mockResolvedValue(Buffer.from('stored PDF text'));
		const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'agent-knowledge-service-'));
		try {
			const files = await service.materializeWorkspace(agentId, projectId, workspaceRoot);

			expect(files).toEqual([
				expect.objectContaining({
					fileName: 'document.pdf',
					mimeType: 'text/plain',
					relativePath: 'file-1.pdf.txt',
					searchable: true,
				}),
			]);
			await expect(readFile(path.join(workspaceRoot, 'file-1.pdf.txt'), 'utf8')).resolves.toBe(
				'stored PDF text',
			);
		} finally {
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});
});
