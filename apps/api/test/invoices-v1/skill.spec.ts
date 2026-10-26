/**
 * The invoice-method skill (samples/skills/invoice-method, plan 18.1): its
 * folder zipped as a user would upload it passes POST
 * /api/resources/skills/validate and is stored by POST /api/resources/skills;
 * it describes method only, naming no task and no answer; and its example
 * script runs on a task's fixtures.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SkillRowSchema, SkillUploadValidationSchema } from '@hermes-evals/shared';
import request from 'supertest';
import { buildZip, startResourcesApp } from '../../src/resources/skills/testing.helper-spec.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { listFiles, readText, SKILL_DIR, SKILL_PHRASE, SUITE_DIR, TASK_KEYS } from './support.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let dataDir: string;
let app: INestApplication;

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'invoice-method-'));
  app = await startResourcesApp(t.db, dataDir);
});

afterEach(async () => {
  await app.close();
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** The skill folder as a zip of its files at the root, in path order. */
async function skillZip(): Promise<Buffer> {
  const files = await listFiles(SKILL_DIR);
  return buildZip(
    await Promise.all(
      files.map(async (path) => ({ path, content: await readFile(join(SKILL_DIR, path)) })),
    ),
  );
}

describe('samples/skills/invoice-method', () => {
  it('has SKILL.md, checklist.md and examples/reconcile.py, and nothing else', async () => {
    expect(await listFiles(SKILL_DIR)).toEqual([
      'SKILL.md',
      'checklist.md',
      'examples/reconcile.py',
    ]);
  });

  it('validates as a new skill and is stored on confirm', async () => {
    const zip = await skillZip();
    const validated = await request(app.getHttpServer())
      .post('/api/resources/skills/validate')
      .attach('file', zip, { filename: 'invoice-method.zip', contentType: 'application/zip' })
      .expect(200);
    const report = SkillUploadValidationSchema.parse(validated.body);
    expect(report).toMatchObject({
      outcome: 'valid',
      name: 'invoice-method',
      version: '1.0.0',
      problems: [],
      existing: null,
    });
    expect(report.description).toMatch(/^A careful method for accounts-payable questions/);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.fileTree.map((f) => f.path)).toEqual([
      'SKILL.md',
      'checklist.md',
      'examples/reconcile.py',
    ]);

    const confirmed = await request(app.getHttpServer())
      .post('/api/resources/skills')
      .send({ token: report.token })
      .expect(201);
    expect(SkillRowSchema.parse(confirmed.body)).toMatchObject({
      name: 'invoice-method',
      version: '1.0.0',
      contentHash: report.contentHash,
    });
  });

  it('holds the sentence the with-skill mock script matches, in the body Hermes preloads', async () => {
    const text = await readText(SKILL_DIR, 'SKILL.md');
    const body = text.slice(text.indexOf('\n---\n', 4) + 5);
    expect(body).toContain(SKILL_PHRASE);
    // The defaults yield to the task's own definitions (plan 18.1, last paragraph).
    expect(body).toContain("the task's definition wins");
  });

  it('describes method only: no task key, invoice number or answer value appears in it', async () => {
    const texts = await Promise.all(
      (await listFiles(SKILL_DIR)).map(async (f) => [f, await readText(SKILL_DIR, f)] as const),
    );
    // `disputed` is also a status the method must name; the other keys are task names only.
    const names = TASK_KEYS.filter((k) => k !== 'disputed');
    const values = new Set<string>();
    for (const key of TASK_KEYS) {
      const collect = (v: unknown): void => {
        if (typeof v === 'number' && !Number.isInteger(v)) values.add(String(v));
        else if (typeof v === 'string' && v.length > 3) values.add(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v !== null && typeof v === 'object') Object.values(v).forEach(collect);
      };
      collect(JSON.parse(await readText(SUITE_DIR, key, 'reference.json')));
    }
    for (const [file, text] of texts) {
      for (const name of names) expect(text.includes(name), `${file} names ${name}`).toBe(false);
      expect(text, file).not.toMatch(/INV-\d{8}|PO-\d{4}/);
      for (const value of values)
        expect(text.includes(value), `${file} holds ${value}`).toBe(false);
    }
  });

  it('runs its example on a task’s ledger and payments', () => {
    const fixtures = join(SUITE_DIR, 'partial_pay/fixtures');
    const run = spawnSync(
      'python3',
      [
        join(SKILL_DIR, 'examples/reconcile.py'),
        join(fixtures, 'invoices.csv'),
        '--payments',
        join(fixtures, 'payments.csv'),
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/invoices\.csv: 48 rows/);
    expect(run.stdout).toMatch(/invoices counted: \d+/);
  });
});
