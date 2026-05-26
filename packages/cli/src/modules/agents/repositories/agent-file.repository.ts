import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AgentFile } from '../entities/agent-file.entity';

@Service()
export class AgentFileRepository extends Repository<AgentFile> {
	constructor(dataSource: DataSource) {
		super(AgentFile, dataSource.manager);
	}

	async findByAgentIdAndResourceId(agentId: string, resourceId: string): Promise<AgentFile[]> {
		return await this.find({
			where: { agentId, resourceId },
			order: { createdAt: 'DESC' },
		});
	}

	async findAllByAgentId(agentId: string): Promise<AgentFile[]> {
		return await this.find({ where: { agentId } });
	}

	async findByIdAgentIdAndResourceId(
		fileId: string,
		agentId: string,
		resourceId: string,
	): Promise<AgentFile | null> {
		return await this.findOne({ where: { id: fileId, agentId, resourceId } });
	}
}
