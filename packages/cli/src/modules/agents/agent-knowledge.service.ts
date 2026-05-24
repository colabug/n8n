import type { AgentFileDto } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { generateNanoId, sanitizeFilename } from '@n8n/utils';
import { BinaryDataService, FileLocation } from 'n8n-core';
import { UnexpectedError, type IBinaryData } from 'n8n-workflow';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { AgentFile } from './entities/agent-file.entity';
import { AgentFileRepository } from './repositories/agent-file.repository';
import { AgentRepository } from './repositories/agent.repository';

export interface KnowledgeWorkspaceFile {
	id: string;
	fileName: string;
	mimeType: string;
	fileSizeBytes: number;
	relativePath: string;
	searchable: boolean;
}

interface StoredFileContent {
	buffer: Buffer;
	mimeType: string;
	fileName: string;
	fileExtension: string | undefined;
}

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

	async deleteFile(agentId: string, projectId: string, fileId: string): Promise<void> {
		await this.ensureAgentBelongsToProject(agentId, projectId);

		const file = await this.agentFileRepository.findByIdAndAgentId(fileId, agentId);
		if (!file) {
			throw new NotFoundError(`Agent file "${fileId}" not found`);
		}

		await this.agentFileRepository.delete({ id: fileId, agentId });
		await this.binaryDataService.deleteManyByBinaryDataId([file.binaryDataId]);
	}

	async materializeWorkspace(agentId: string, projectId: string, workspaceRoot: string) {
		await this.ensureAgentBelongsToProject(agentId, projectId);
		await mkdir(workspaceRoot, { recursive: true });

		const files = await this.agentFileRepository.findByAgentId(agentId);
		const materializedFiles: KnowledgeWorkspaceFile[] = [];

		for (const file of files) {
			const relativePath = this.getWorkspaceRelativePath(file);
			const targetPath = path.join(workspaceRoot, relativePath);
			const searchable = this.isSearchable(file);

			if (searchable) {
				const buffer = await this.binaryDataService.getAsBuffer({
					id: file.binaryDataId,
					data: '',
					mimeType: file.mimeType,
				});
				await writeFile(targetPath, buffer);
			}

			materializedFiles.push({
				id: file.id,
				fileName: file.fileName,
				mimeType: file.mimeType,
				fileSizeBytes: file.fileSizeBytes,
				relativePath,
				searchable,
			});
		}

		return materializedFiles;
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
			const storedContent = await this.prepareStoredContent(fileName, file.mimetype, buffer);
			const binaryData: IBinaryData = {
				data: '',
				mimeType: storedContent.mimeType,
				fileName: storedContent.fileName,
				fileSize: `${storedContent.buffer.length}`,
				bytes: storedContent.buffer.length,
				fileExtension: storedContent.fileExtension,
			};

			const storedBinaryData = await this.binaryDataService.store(
				FileLocation.ofCustom({
					sourceType: 'agent_file',
					sourceId: fileId,
					pathSegments: ['agents', agentId, 'files', fileId],
				}),
				storedContent.buffer,
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
				mimeType: storedContent.mimeType,
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

	private isSearchable(file: AgentFile) {
		const extension = file.fileName.split('.').pop()?.toLowerCase();
		return (
			file.mimeType === 'text/csv' ||
			file.mimeType === 'text/plain' ||
			file.mimeType === 'text/markdown' ||
			extension === 'csv' ||
			extension === 'txt' ||
			extension === 'md' ||
			extension === 'markdown'
		);
	}

	private getWorkspaceRelativePath(file: AgentFile) {
		const extension = file.fileName.split('.').pop()?.toLowerCase();
		if (extension === 'pdf' && file.mimeType === 'text/plain') {
			return `${file.id}.pdf.txt`;
		}
		return `${file.id}${path.extname(file.fileName)}`;
	}

	private async prepareStoredContent(
		fileName: string,
		mimeType: string,
		buffer: Buffer,
	): Promise<StoredFileContent> {
		if (!this.isPdf(fileName, mimeType)) {
			return {
				buffer,
				mimeType: mimeType || 'application/octet-stream',
				fileName,
				fileExtension: fileName.split('.').pop(),
			};
		}

		const extractedText = await this.extractPdfText(fileName, buffer);
		const extractedBuffer = Buffer.from(extractedText, 'utf8');

		return {
			buffer: extractedBuffer,
			mimeType: 'text/plain',
			fileName: `${fileName}.txt`,
			fileExtension: 'txt',
		};
	}

	private isPdf(fileName: string, mimeType: string) {
		return path.extname(fileName).toLowerCase() === '.pdf' || mimeType === 'application/pdf';
	}

	private async extractPdfText(fileName: string, buffer: Buffer) {
		const { PDFParse } = await import('pdf-parse');
		const parser = new PDFParse({ data: buffer });
		try {
			const result = await parser.getText();
			const text = result.text.trim();
			if (!text) {
				throw new BadRequestError(
					`PDF "${fileName}" contains no extractable text and cannot be added to knowledge`,
				);
			}
			return text;
		} catch (error) {
			if (error instanceof BadRequestError) throw error;
			const message = error instanceof Error ? error.message : 'unknown error';
			throw new BadRequestError(`Failed to extract text from PDF "${fileName}": ${message}`);
		} finally {
			await parser.destroy();
		}
	}
}
