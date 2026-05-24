import type { AgentFileDto } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { generateNanoId, sanitizeFilename } from '@n8n/utils';
import { BinaryDataService, FileLocation } from 'n8n-core';
import { UnexpectedError, type IBinaryData } from 'n8n-workflow';
import { readFile, unlink } from 'node:fs/promises';

import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { AgentFile } from './entities/agent-file.entity';
import { AgentFileRepository } from './repositories/agent-file.repository';
import { AgentRepository } from './repositories/agent.repository';

@Service()
export class AgentKnowledgeService {
	constructor(
		private readonly agentRepository: AgentRepository,
		private readonly agentFileRepository: AgentFileRepository,
		private readonly binaryDataService: BinaryDataService,
	) {}

	async uploadFiles(
		agentId: string,
		projectId: string,
		files: Express.Multer.File[],
	): Promise<AgentFileDto[]> {
		await this.ensureAgentBelongsToProject(agentId, projectId);

		const storedFiles: AgentFile[] = [];

		for (const file of files) {
			storedFiles.push(await this.storeFile(agentId, file));
		}

		return storedFiles.map((file) => this.toDto(file));
	}

	async listFiles(agentId: string, projectId: string): Promise<AgentFileDto[]> {
		await this.ensureAgentBelongsToProject(agentId, projectId);

		const files = await this.agentFileRepository.findByAgentId(agentId);
		return files.map((file) => this.toDto(file));
	}

	private async ensureAgentBelongsToProject(agentId: string, projectId: string) {
		const agent = await this.agentRepository.findByIdAndProjectId(agentId, projectId);
		if (!agent) {
			throw new NotFoundError(`Agent "${agentId}" not found`);
		}
	}

	private async storeFile(agentId: string, file: Express.Multer.File): Promise<AgentFile> {
		try {
			const fileId = generateNanoId();
			const fileName = sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'));
			const buffer = file.buffer ?? (await readFile(file.path));
			const mimeType = file.mimetype || 'application/octet-stream';
			const binaryData: IBinaryData = {
				data: '',
				mimeType,
				fileName,
				fileSize: `${buffer.length}`,
				bytes: buffer.length,
				fileExtension: fileName.split('.').pop(),
			};

			const storedBinaryData = await this.binaryDataService.store(
				FileLocation.ofCustom({
					sourceType: 'agent_file',
					sourceId: fileId,
					pathSegments: ['agents', agentId, 'files', fileId],
				}),
				buffer,
				binaryData,
			);

			if (!storedBinaryData.id) {
				throw new UnexpectedError('Agent file upload requires persisted binary data');
			}

			const agentFile = this.agentFileRepository.create({
				id: fileId,
				agentId,
				binaryDataId: storedBinaryData.id,
				fileName,
				mimeType,
				fileSizeBytes: buffer.length,
			});

			return await this.agentFileRepository.save(agentFile);
		} finally {
			if (file.path) {
				await unlink(file.path).catch(() => {});
			}
		}
	}

	private toDto(file: AgentFile): AgentFileDto {
		return {
			id: file.id,
			agentId: file.agentId,
			binaryDataId: file.binaryDataId,
			fileName: file.fileName,
			mimeType: file.mimeType,
			fileSizeBytes: file.fileSizeBytes,
			createdAt: file.createdAt.toISOString(),
		};
	}
}
