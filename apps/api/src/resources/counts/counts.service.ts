import { Inject, Injectable } from '@nestjs/common';
import { count } from 'drizzle-orm';
import type { ResourceCounts } from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import { documents, mcpServers, skills } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { SecretsService } from '../secrets/secrets.service.js';

/**
 * GET /resources/counts: the tab counts of the Resources page, each the
 * length of the list that tab shows (a skill counts once per version, a
 * secret once per name and source).
 */
@Injectable()
export class CountsService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Inject(SecretsService) private readonly secrets: SecretsService,
  ) {}

  async counts(): Promise<ResourceCounts> {
    const total = async (table: typeof skills | typeof documents | typeof mcpServers) =>
      (await this.db.select({ n: count() }).from(table))[0]?.n ?? 0;
    const [skillCount, documentCount, mcpCount, secretRows] = await Promise.all([
      total(skills),
      total(documents),
      total(mcpServers),
      this.secrets.list(),
    ]);
    return {
      skills: skillCount,
      documents: documentCount,
      mcpServers: mcpCount,
      secrets: secretRows.length,
    };
  }
}
