/**
 * Test helpers for the draft specs: a small suite folder written to a
 * temporary SUITES_DIR and loaded twice by the real loader (v1, then v2
 * with total_due changed), into PGlite and a blob store in the same
 * temporary directory, and a Nest app with the drafts module (and the
 * suites module after it, as AppModule orders them). Test-only: the name
 * ends in `-spec.ts`, so the build leaves it out, and not in `.spec.ts`,
 * so vitest does not run it as a test file.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import type { PgBoss } from 'pg-boss';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { DB } from '../../database/db.provider.js';
import { QueueService } from '../../queue/queue.service.js';
import { configOf, silentLogger, testEnv } from '../../resources/skills/testing.helper-spec.js';
import { BlobStore } from '../../storage/blob-store.js';
import { StorageService } from '../../storage/storage.service.js';
import { SuiteLoader } from '../loader/suite-loader.js';
import { SuitesModule } from '../suites.module.js';
import { SuiteDraftsModule } from './drafts.module.js';

export const SUITE_YAML = `name: invoices-v1
version_label: '0.3'
description: Two accounts-payable questions over one ledger.
tasks:
  - total_due
  - summary_file
`;

export const TOTAL_DUE_YAML = `# The sum of every invoice not yet paid.
summary: Total amount still due   # shown in lists
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file, terminal]
answer:
  format: fenced_json
  path: total_due
verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params: { abs: 0.01 }
  - key: reads_invoices
    type: trajectory_match
    params: { tool: read_file }
`;

export const TOTAL_DUE_PROMPT = `Your working directory contains \`invoices.csv\`.

What is the total amount still due?

End your reply with your answer as a fenced JSON block, exactly in this shape:

\`\`\`json
{ "total_due": 0.0 }
\`\`\`
`;

export const INVOICES_CSV =
  'invoice_no,amount,status\nINV-1,1000.50,open\nINV-2,234.06,open\nINV-3,99.00,paid\n';

export const SUMMARY_YAML = `summary: Write summary.csv with one row per vendor
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file]
answer:
  format: fenced_json
verification:
  - key: file
    type: file_check
    primary: true
    params: { path: summary.csv, format: csv, row_count: 2 }
  - key: totals
    type: verifier_script
    params: { script: check.py, timeout_s: 10 }
self_check:
  expected_workspace: expected
`;

export const CHECK_PY = `import argparse, json, pathlib
p = argparse.ArgumentParser()
p.add_argument("--answer")
p.add_argument("--workspace")
p.add_argument("--home")
a = p.parse_args()
ok = (pathlib.Path(a.workspace) / "summary.csv").exists()
print(json.dumps({"score": 1.0 if ok else 0.0, "comment": "summary.csv " + ("found" if ok else "missing")}))
`;

/** The suite folder, path → content; v2 changes total_due's reference and prompt. */
export function suiteFiles(version: 1 | 2): Record<string, string> {
  return {
    'suite.yaml': SUITE_YAML,
    'total_due/task.yaml': TOTAL_DUE_YAML,
    'total_due/prompt.md':
      version === 1 ? TOTAL_DUE_PROMPT.replace('still due?', 'due?') : TOTAL_DUE_PROMPT,
    'total_due/reference.json':
      version === 1 ? '{\n  "total_due": 1000.5\n}\n' : '{\n  "total_due": 1234.56\n}\n',
    'total_due/fixtures/invoices.csv': INVOICES_CSV,
    'summary_file/task.yaml': SUMMARY_YAML,
    'summary_file/prompt.md':
      'Read `invoices.csv` and write `summary.csv`.\n\nAnswer as a fenced json block: ```json\n{ "rows": 0 }\n```\n',
    'summary_file/reference.json': '{ "rows": 2 }\n',
    'summary_file/fixtures/invoices.csv': INVOICES_CSV,
    'summary_file/expected/summary.csv': 'vendor,total\nA,1\nB,2\n',
    'summary_file/verify/check.py': CHECK_PY,
    'summary_file/README.md': '# Notes\n',
  };
}

export async function writeSuite(
  root: string,
  folder: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, folder, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/** A queue stand-in: the drafts routes send no job; the suites module only needs one to exist. */
const boss = { send: async () => 'job', findJobs: async () => [] } as unknown as PgBoss;

export interface DraftsApp {
  app: INestApplication;
  t: TestDatabase;
  store: BlobStore;
  root: string;
  suitesDir: string;
  loader: SuiteLoader;
  /** supertest against the app; state-changing calls carry X-Requested-With. */
  http: () => ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function startDraftsApp(): Promise<DraftsApp> {
  const t = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'drafts-spec-'));
  const suitesDir = join(root, 'suites');
  const store = new BlobStore(join(root, 'data'));
  const loader = new SuiteLoader({
    db: t.db,
    blobs: store,
    suitesDir,
    logger: silentLogger,
  });
  await writeSuite(suitesDir, 'invoices-v1', suiteFiles(1));
  await loader.loadOne('invoices-v1');
  await writeSuite(suitesDir, 'invoices-v1', suiteFiles(2));
  await loader.loadOne('invoices-v1');

  const config = configOf({ ...testEnv(store.dataDir), SUITE_RELOAD_TIMEOUT_S: 1 });
  @Global()
  @Module({
    providers: [
      { provide: DB, useValue: t.db },
      { provide: ConfigService, useValue: config },
      { provide: PinoLogger, useValue: silentLogger },
      { provide: QueueService, useValue: { instance: boss } },
    ],
    exports: [DB, ConfigService, PinoLogger, QueueService],
  })
  class InfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [InfraModule, SuiteDraftsModule, SuitesModule],
  })
    .overrideProvider(StorageService)
    .useValue(store)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  const http = () => request(app.getHttpServer());
  return {
    app,
    t,
    store,
    root,
    suitesDir,
    loader,
    http,
    close: async () => {
      await app.close();
      await t.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The headers RequestedWithGuard asks of a state-changing request. */
export const WRITE = { 'X-Requested-With': 'test' } as const;
