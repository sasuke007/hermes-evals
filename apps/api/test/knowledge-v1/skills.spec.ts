/**
 * The knowledge of knowledge-v1's arms (plan 18.3, Phase 6b R3 and R6): the
 * skills bx7-format, house-style and the decoy bx6-format, each zipped as a
 * user uploads it, pass POST /api/resources/skills/validate and are stored
 * on confirm; the documents in samples/documents/knowledge-v1 are the
 * skills' own text and upload through POST /api/resources/documents under
 * their names, which is what workspace/docs/ will hold; the short code list
 * of SKILL.md agrees with codes.md; and the knowledge names no task and no
 * answer.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  DocumentRowSchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
} from '@hermes-evals/shared';
import request from 'supertest';
import { buildZip, startResourcesApp } from '../../src/resources/skills/testing.helper-spec.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  DOCUMENTS,
  DOCUMENTS_DIR,
  frontMatter,
  listFiles,
  readText,
  SKILL_NAMES,
  skillBody,
  SKILLS_DIR,
  SUITE_DIR,
  TASK_FILES,
  TASK_KEYS,
  type SkillName,
} from './support.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let dataDir: string;
let app: INestApplication;

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'knowledge-v1-skills-'));
  app = await startResourcesApp(t.db, dataDir);
});

afterEach(async () => {
  await app.close();
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

const FILES: Record<SkillName, string[]> = {
  'bx7-format': ['SKILL.md', 'codes.md', 'scripts/bx7.py'],
  'house-style': ['SKILL.md', 'templates/summary-template.md'],
  'bx6-format': ['SKILL.md'],
};

/** The skill folder as a zip of its files at the root, in path order. */
async function skillZip(name: SkillName): Promise<Buffer> {
  const dir = join(SKILLS_DIR, name);
  const files = await listFiles(dir);
  return buildZip(
    await Promise.all(
      files.map(async (path) => ({ path, content: await readFile(join(dir, path)) })),
    ),
  );
}

describe('the skills', () => {
  it('hold exactly their files', async () => {
    for (const name of SKILL_NAMES) {
      expect(await listFiles(join(SKILLS_DIR, name)), name).toEqual(FILES[name]);
    }
  });

  it.each(SKILL_NAMES)('%s validates as a new skill and is stored on confirm', async (name) => {
    const validated = await request(app.getHttpServer())
      .post('/api/resources/skills/validate')
      .attach('file', await skillZip(name), {
        filename: `${name}.zip`,
        contentType: 'application/zip',
      })
      .expect(200);
    const report = SkillUploadValidationSchema.parse(validated.body);
    expect(report).toMatchObject({
      outcome: 'valid',
      name,
      version: '1.0.0',
      problems: [],
      existing: null,
    });
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.fileTree.map((f) => f.path)).toEqual(FILES[name]);
    const confirmed = await request(app.getHttpServer())
      .post('/api/resources/skills')
      .send({ token: report.token })
      .expect(201);
    expect(SkillRowSchema.parse(confirmed.body)).toMatchObject({
      name,
      version: '1.0.0',
      contentHash: report.contentHash,
    });
  });

  it('list in SKILL.md only codes that codes.md holds, with the same name and class, and not the whole table', async () => {
    const codes = await readText(SKILLS_DIR, 'bx7-format/codes.md');
    const table = new Map(
      [...codes.matchAll(/^\| ([A-Z]\d\d) +\| ([^|]+?) +\| ([a-z]+) +\|$/gm)].map((m) => [
        m[1]!,
        `${m[2]!} ${m[3]!}`,
      ]),
    );
    const skill = await readText(SKILLS_DIR, 'bx7-format/SKILL.md');
    const listed = [...skill.matchAll(/^\| `([A-Z]\d\d)` +\| ([^|]+?) +\| `([a-z]+)` +\|$/gm)];
    expect(listed.map((m) => m[1])).toEqual(['C11', 'P20', 'R31', 'K52', 'N70']);
    for (const m of listed) expect(table.get(m[1]!), m[1]).toBe(`${m[2]!} ${m[3]!}`);
    // The fee codes beyond the short list are what reason_codes needs codes.md for.
    const fees = [...table].filter(([, v]) => v.endsWith(' fee')).map(([k]) => k);
    expect(fees).toEqual(['K52', 'K55', 'K58', 'X84']);
    expect(skill).toContain('The full table, with the name and class of every code');
  });

  it('describe the knowledge only: no task key, file name or answer value appears in them', async () => {
    const values = new Set<string>();
    const collect = (v: unknown): void => {
      if (typeof v === 'number' && !Number.isInteger(v)) values.add(String(v));
      else if (typeof v === 'string' && v.length > 3) values.add(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(collect);
    };
    for (const key of TASK_KEYS) {
      collect(JSON.parse(await readText(SUITE_DIR, key, 'reference.json')));
    }
    const texts = await Promise.all(
      SKILL_NAMES.flatMap((name) =>
        FILES[name].map(
          async (f) => [`${name}/${f}`, await readText(SKILLS_DIR, name, f)] as const,
        ),
      ),
    );
    for (const [file, text] of texts) {
      // bx7.py's JSON has a closing_balance field, which is the format's word, not the task's.
      if (!file.endsWith('.py')) {
        for (const key of TASK_KEYS) expect(text.includes(key), `${file} names ${key}`).toBe(false);
      }
      for (const key of TASK_KEYS) {
        const name = TASK_FILES[key].file;
        expect(text.includes(name), `${file} names ${name}`).toBe(false);
      }
      for (const value of values)
        expect(text.includes(value), `${file} holds ${value}`).toBe(false);
    }
  });

  it('describe each skill in its front matter without the body’s reference phrase', async () => {
    for (const name of SKILL_NAMES) {
      const text = await readText(SKILLS_DIR, name, 'SKILL.md');
      const { name: declared, description } = frontMatter(text);
      expect(declared).toBe(name);
      expect(description.length).toBeGreaterThan(40);
      expect(description).not.toMatch(/kv1-/);
      expect(skillBody(text)).toMatch(/kv1-/);
    }
  });
});

describe('samples/documents/knowledge-v1', () => {
  it('holds one document per knowledge file, each the skill file’s text', async () => {
    expect(await listFiles(DOCUMENTS_DIR)).toEqual(DOCUMENTS.map((d) => d.doc));
    for (const { doc, skill } of DOCUMENTS) {
      const text = await readText(SKILLS_DIR, skill);
      const expected = skill.endsWith('SKILL.md') ? skillBody(text) : text;
      expect(await readText(DOCUMENTS_DIR, doc), doc).toBe(expected);
    }
  });

  it('uploads every document under its own name, which is the name workspace/docs/ gives it', async () => {
    for (const { doc } of DOCUMENTS) {
      const content = await readFile(join(DOCUMENTS_DIR, doc));
      const created = await request(app.getHttpServer())
        .post('/api/resources/documents')
        .attach('file', content, { filename: doc })
        .expect(201);
      expect(DocumentRowSchema.parse(created.body), doc).toMatchObject({
        filename: doc,
        sizeBytes: content.length,
      });
    }
  });
});
