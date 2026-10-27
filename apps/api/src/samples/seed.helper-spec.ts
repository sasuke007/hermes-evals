/**
 * The samples seed's dependencies on a test database, for the seed's
 * integration specs: the services the pages use, on a blob store in
 * `dataDir`, and a report that takes each item as the seed decides it.
 */
import { fileURLToPath } from 'node:url';
import type { SeedItem } from '@hermes-evals/shared';
import type { TestDatabase } from '../../test/support/database.js';
import { ConfigurationWritesService } from '../configurations/configuration-writes.service.js';
import { DocumentsService } from '../resources/documents/documents.service.js';
import { McpServersService } from '../resources/mcp/mcp-servers.service.js';
import { SkillUploadStore } from '../resources/skills/skill-uploads.js';
import { SkillsService } from '../resources/skills/skills.service.js';
import { configOf, silentLogger, testEnv } from '../resources/skills/testing.helper-spec.js';
import { StorageService } from '../storage/storage.service.js';
import type { SeedDeps } from './seed.js';

/** The repository's samples/. */
export const SAMPLES = fileURLToPath(new URL('../../../../samples', import.meta.url));

/** The seed's dependencies on `t`, storing blobs under `dataDir`. */
export function seedDepsOn(
  t: TestDatabase,
  dataDir: string,
  report: (item: SeedItem) => void,
): SeedDeps {
  const config = configOf(testEnv(dataDir));
  const storage = new StorageService(config, silentLogger);
  return {
    db: t.db,
    storage,
    skills: new SkillsService(
      t.db,
      storage,
      new SkillUploadStore(storage, config, silentLogger),
      silentLogger,
    ),
    documents: new DocumentsService(t.db, storage, silentLogger),
    mcpServers: new McpServersService(t.db),
    configurations: new ConfigurationWritesService(t.db),
    report,
  };
}
