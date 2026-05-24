import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import type { RequestHandler } from 'express';
import multer from 'multer';
import path from 'node:path';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';

export const ALLOWED_AGENT_FILE_EXTENSIONS = ['.md', '.markdown', '.pdf', '.txt'] as const;

const allowedAgentFileExtensions = new Set<string>(ALLOWED_AGENT_FILE_EXTENSIONS);

export function isAllowedAgentFile(file: Pick<Express.Multer.File, 'originalname'>) {
	const extension = path.extname(file.originalname).toLowerCase();

	return allowedAgentFileExtensions.has(extension);
}

@Service()
export class AgentUploadMiddleware {
	private readonly upload: multer.Multer;

	constructor(globalConfig: GlobalConfig) {
		const maxFileSizeBytes = globalConfig.endpoints.formDataFileSizeMax * 1024 * 1024;
		this.upload = multer({
			storage: multer.diskStorage({}),
			limits: { fileSize: maxFileSizeBytes },
			fileFilter: (_req, file, callback) => {
				if (!isAllowedAgentFile(file)) {
					callback(new BadRequestError('Only PDF, Markdown, and TXT files are allowed'));
					return;
				}

				callback(null, true);
			},
		});
	}

	array(fieldName: string): RequestHandler {
		return (req, res, next) => {
			void this.upload.array(fieldName)(req, res, (error) => {
				if (error) {
					(req as typeof req & { fileUploadError?: Error }).fileUploadError = error as Error;
				}
				next();
			});
		};
	}
}
