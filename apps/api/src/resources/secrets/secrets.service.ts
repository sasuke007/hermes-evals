import { Inject, Injectable } from '@nestjs/common';
import type { SecretRow } from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import { findLiveWorker } from '../../queue/live-worker.js';
import { latestVersions, referencedVersions } from '../mcp/mcp-reads.js';
import { secretRows } from './presence.js';

/**
 * GET /resources/secrets: every name that MCP definitions reference (plan
 * 5.3, UI_FLOWS 9.4), and whether the live worker (for stdio env) or egress
 * through it (for http headers) reported having each. The definitions are
 * each server's latest version and every older version a configuration still
 * pins: editing a frozen server creates v2 while configurations stay on v1,
 * and their next run starts v1, so v1's names are still needed.
 */
@Injectable()
export class SecretsService {
  constructor(@Inject(DB) private readonly db: AppDb) {}

  async list(): Promise<SecretRow[]> {
    const [latest, pinned, worker] = await Promise.all([
      latestVersions(this.db),
      referencedVersions(this.db),
      findLiveWorker(this.db),
    ]);
    const byVersionId = new Map<string, (typeof latest)[number]>();
    for (const row of [...latest, ...pinned]) byVersionId.set(row.version.id, row);
    return secretRows(
      [...byVersionId.values()].map(({ server, version }) => ({
        id: server.id,
        name: server.name,
        transport: version.transport,
        envNames: version.envNames,
        headers: version.headers,
      })),
      worker,
      new Date(),
    );
  }
}
