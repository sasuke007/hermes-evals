/**
 * The samples seed's rule for documents (Phase 8 G3) on PGlite: a sample
 * file is skipped only when a document with the same name AND the same
 * content (sha256) exists. The sample names are generic (invoices.csv,
 * codes.md), so a user's own file that shares a sample's name but not its
 * content, or its content but not its name, is left alone: the sample is
 * stored beside it, and the seeded configurations attach the sample's
 * document, never the user's. Every view is checked with its shared schema.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigurationDetailSchema,
  DocumentRowSchema,
  SeedItemSchema,
  sampleConfigurationName,
  type DocumentRow,
  type SeedItem,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { ConfigurationReadsService } from '../configurations/configuration-reads.service.js';
import { configurations } from '../database/schema/index.js';
import { uploadedFile } from '../resources/skills/testing.helper-spec.js';
import { SAMPLES, seedDepsOn } from './seed.helper-spec.js';
import { seedSamples, type SeedDeps } from './seed.js';

// PGlite databases are slow to create when every test file runs at once.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

/** The sample ledger, and the configurations that attach it as a document. */
const LEDGER = 'mcp-v1/invoices.csv';
const ATTACHING = [
  sampleConfigurationName('mcp-v1', 'docs-export', 'real'),
  sampleConfigurationName('mcp-v1', 'docs-export', 'mock'),
];

let t: TestDatabase;
let dataDir: string;
let items: SeedItem[];
let deps: SeedDeps;

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'samples-seed-documents-'));
  items = [];
  deps = seedDepsOn(t, dataDir, (item) => items.push(SeedItemSchema.parse(item)));
});

afterEach(async () => {
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Uploads a document of the user's own, as the Documents page does. */
async function uploadMine(content: Buffer | string, filename: string): Promise<DocumentRow> {
  return DocumentRowSchema.parse(
    await deps.documents.upload(await uploadedFile(deps.storage, content, filename, 'text/csv')),
  );
}

/** Seeds the repository's samples and returns what it reported. */
async function seed(): Promise<SeedItem[]> {
  items = [];
  await seedSamples(deps, SAMPLES);
  return items;
}

/** The document ids the latest version of each configuration in ATTACHING holds. */
async function attachedIds(): Promise<string[][]> {
  const reads = new ConfigurationReadsService(t.db);
  const out: string[][] = [];
  for (const name of ATTACHING) {
    const [row] = await t.db
      .select({ id: configurations.id })
      .from(configurations)
      .where(eq(configurations.name, name));
    const detail = ConfigurationDetailSchema.parse(await reads.detail(row!.id));
    out.push(detail.latest.documents.map((d) => d.documentId));
  }
  return out;
}

/** The user's document as the Documents page lists it now. */
async function listed(id: string): Promise<DocumentRow | undefined> {
  const rows = DocumentRowSchema.array().parse(await deps.documents.list());
  return rows.find((row) => row.id === id);
}

describe("a user's document beside a sample", () => {
  it('stores the sample beside a file of the same name and other content, and attaches the sample', async () => {
    const mine = await uploadMine('invoice_no,amount\nMINE-1,1.00\n', 'invoices.csv');
    const seeded = await seed();
    expect(seeded.find((i) => i.name === LEDGER)).toEqual({
      kind: 'document',
      name: LEDGER,
      outcome: 'created',
      detail: expect.any(String),
    });
    expect(seeded.filter((i) => i.outcome === 'failed')).toEqual([]);

    // Both configurations attach the sample ledger, a new row of the same name, never mine.
    const rows = DocumentRowSchema.array().parse(await deps.documents.list());
    const ledgers = rows.filter((row) => row.filename === 'invoices.csv');
    expect(ledgers).toHaveLength(2);
    const sample = ledgers.find((row) => row.id !== mine.id)!;
    expect(sample.sha256).not.toBe(mine.sha256);
    for (const ids of await attachedIds()) {
      expect(ids).toHaveLength(2);
      expect(ids).toContain(sample.id);
      expect(ids).not.toContain(mine.id);
    }
    // The user's row is as it was: attached to nothing.
    expect(await listed(mine.id)).toEqual(mine);
  });

  it('stores the sample beside a file of the same content and another name, and attaches the sample', async () => {
    const ledger = await readFile(join(SAMPLES, 'documents', LEDGER));
    const mine = await uploadMine(ledger, 'mine.csv');
    const seeded = await seed();
    expect(seeded.find((i) => i.name === LEDGER)).toMatchObject({ outcome: 'created' });

    // The sample's own row: the same content under the sample's name, attached instead of mine.
    const rows = DocumentRowSchema.array().parse(await deps.documents.list());
    const same = rows.filter((row) => row.sha256 === mine.sha256);
    expect(same.map((row) => row.filename).sort()).toEqual(['invoices.csv', 'mine.csv']);
    const sample = same.find((row) => row.id !== mine.id)!;
    for (const ids of await attachedIds()) {
      expect(ids).toHaveLength(2);
      expect(ids).toContain(sample.id);
      expect(ids).not.toContain(mine.id);
    }
    expect(await listed(mine.id)).toEqual(mine);
  });
});
