/**
 * SkillsService on PGlite with a real DATA_DIR: validate, confirm, the
 * conflict and new-version outcomes, expired and unknown tokens, a confirm
 * that loses a race, "Used by" from the latest configuration versions, and
 * reading a stored skill back. Every result is checked against the shared
 * contract.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SkillDetailSchema,
  SkillFileContentSchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
  type SkillUploadValidation,
} from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { sha } from '../../../test/support/seed.js';
import { skills } from '../../database/schema/index.js';
import { StorageService } from '../../storage/storage.service.js';
import { skillContentHash } from './skill-files.js';
import { SkillUploadStore } from './skill-uploads.js';
import {
  buildZip,
  collect,
  configOf,
  httpFailure,
  invoiceMethodZip,
  seedConfiguration,
  silentLogger,
  skillMd,
  testEnv,
  uploadedFile,
} from './testing.helper-spec.js';
import { SkillsService } from './skills.service.js';
import { unpackSkillZip } from './zip-reader.js';

// PGlite databases are slow to create when every test file runs at once.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let t: TestDatabase;
let dataDir: string;
let storage: StorageService;
let uploads: SkillUploadStore;
let service: SkillsService;

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'skills-service-'));
  const config = configOf(testEnv(dataDir));
  storage = new StorageService(config, silentLogger);
  uploads = new SkillUploadStore(storage, config, silentLogger);
  service = new SkillsService(t.db, storage, uploads, silentLogger);
});

afterEach(async () => {
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function validate(zip: Buffer, name = 'invoice-method.zip'): Promise<SkillUploadValidation> {
  const file = await uploadedFile(storage, zip, name, 'application/zip');
  return SkillUploadValidationSchema.parse(await service.validate(file));
}

describe('SkillsService.validate', () => {
  it('reports a new skill as valid, worded like the fixtures, and keeps its tree under the token', async () => {
    const report = await validate(await invoiceMethodZip());
    expect(report).toMatchObject({
      outcome: 'valid',
      fileName: 'invoice-method.zip',
      name: 'invoice-method',
      version: '1.0.0',
      description: 'Method for reconciling vendor invoices',
      problems: [],
      existing: null,
    });
    expect(report.token).toMatch(/^[0-9a-f]{64}$/);
    expect(report.checks).toEqual([
      { label: 'SKILL.md', value: 'found at zip root', ok: true },
      { label: 'name', value: 'invoice-method', ok: true },
      { label: 'version', value: '1.0.0', ok: true },
      { label: 'description', value: 'Method for reconciling vendor invoices', ok: true },
      { label: 'files', value: `4 files · ${report.unpackedBytes} B unpacked`, ok: true },
      { label: 'content hash', value: `sha256:${report.contentHash}`, ok: true },
    ]);
    expect(report.fileTree.map((f) => f.path)).toEqual([
      'SKILL.md',
      'checklist.csv',
      'examples/reconcile.py',
      'logo.bin',
    ]);
    // Nothing is stored before confirm: no row and no DATA_DIR/skills.
    expect(await t.db.select().from(skills)).toEqual([]);
    expect(await readdir(dataDir)).not.toContain('skills');
    expect(await readdir(join(uploads.root, report.token!))).toEqual(['manifest.json', 'tree']);
  });

  it('accepts a zip of the folder itself and strips that folder', async () => {
    const zip = await buildZip([
      { path: 'invoice-method/', folder: true },
      { path: 'invoice-method/SKILL.md', content: skillMd() },
      { path: 'invoice-method/notes.md', content: '# Notes\n' },
    ]);
    const report = await validate(zip);
    expect(report.outcome).toBe('valid');
    expect(report.checks[0]).toEqual({
      label: 'SKILL.md',
      value: 'found in invoice-method/',
      ok: true,
    });
    expect(report.fileTree.map((f) => f.path)).toEqual(['SKILL.md', 'notes.md']);
    // The hash is the stripped tree's, so it equals the same files zipped at the root.
    const flat = await validate(
      await buildZip([
        { path: 'notes.md', content: '# Notes\n' },
        { path: 'SKILL.md', content: skillMd() },
      ]),
    );
    expect(flat.contentHash).toBe(report.contentHash);
  });

  it('reports missing metadata as invalid, gives no token and keeps nothing', async () => {
    const report = await validate(await invoiceMethodZip({ version: null }));
    expect(report).toMatchObject({ outcome: 'invalid', token: null, existing: null });
    expect(report.problems).toEqual([
      { title: 'No version in metadata.', detail: 'Add version: to the SKILL.md front matter.' },
    ]);
    expect(report.checks).toContainEqual({ label: 'version', value: 'missing', ok: false });
    expect(await readdir(uploads.root)).toEqual([]);
  });

  it('reports an unsafe zip as invalid with its listing and keeps nothing', async () => {
    const zip = await buildZip([
      { path: 'SKILL.md', content: skillMd() },
      { path: 'link', content: '/etc/passwd', mode: 0o120777 },
    ]);
    const report = await validate(zip);
    expect(report).toMatchObject({ outcome: 'invalid', token: null, checks: [], name: null });
    expect(report.problems).toEqual([
      expect.objectContaining({ title: 'Symbolic link in the zip.' }),
    ]);
    expect(await readdir(uploads.root)).toEqual([]);
  });
});

describe('SkillsService.confirm', () => {
  it('stores the tree by content hash, inserts the row and discards the upload', async () => {
    const report = await validate(await invoiceMethodZip());
    const row = SkillRowSchema.parse(await service.confirm(report.token!));
    expect(row).toMatchObject({
      name: 'invoice-method',
      version: '1.0.0',
      contentHash: report.contentHash,
      fileCount: 4,
      unpackedBytes: report.unpackedBytes,
      usedBy: [],
    });
    const tree = service.treePath(row.contentHash);
    expect((await readdir(tree, { recursive: true })).sort()).toEqual([
      'SKILL.md',
      'checklist.csv',
      'examples',
      'examples/reconcile.py',
      'logo.bin',
    ]);
    expect(await readFile(join(tree, 'SKILL.md'), 'utf8')).toBe(skillMd());
    expect(await readdir(uploads.root)).toEqual([]);
    // A token is good once.
    expect(await httpFailure(service.confirm(report.token!))).toMatchObject({ status: 404 });
  });

  it('answers 404 for a token never issued and 410 once one expired', async () => {
    expect(await httpFailure(service.confirm('f'.repeat(64)))).toEqual({
      status: 404,
      body: {
        statusCode: 404,
        message: 'no skill upload has this token; validate the zip again',
      },
    });
    expect(await httpFailure(service.confirm('../../etc'))).toMatchObject({ status: 404 });

    const report = await validate(await invoiceMethodZip());
    const manifestPath = join(uploads.root, report.token!, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { expiresAt: string };
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(await httpFailure(service.confirm(report.token!))).toEqual({
      status: 410,
      body: { statusCode: 410, message: 'this skill upload expired; validate the zip again' },
    });
    // The sweep removed the tree but kept the manifest, so the answer stays 410 for a day.
    await uploads.sweep();
    expect(await readdir(join(uploads.root, report.token!))).toEqual(['manifest.json']);
    expect(await httpFailure(service.confirm(report.token!))).toMatchObject({ status: 410 });
    await uploads.sweep(Date.now() + 25 * 3600 * 1000);
    expect(await httpFailure(service.confirm(report.token!))).toMatchObject({ status: 404 });
    expect(await t.db.select().from(skills)).toEqual([]);
  });

  it('answers 409 when the same name and version was stored while the upload waited', async () => {
    const first = await validate(await invoiceMethodZip());
    const second = await validate(
      await invoiceMethodZip({}, [{ path: 'extra.md', content: 'x\n' }]),
    );
    expect(second.outcome).toBe('valid');
    await service.confirm(first.token!);
    expect(await httpFailure(service.confirm(second.token!))).toEqual({
      status: 409,
      body: {
        statusCode: 409,
        message: 'invoice-method 1.0.0 was stored while this upload waited; validate the zip again',
      },
    });
    expect(await t.db.select().from(skills)).toHaveLength(1);
    // The losing upload is discarded and its tree never reached DATA_DIR/skills.
    expect(await readdir(uploads.root)).toEqual([]);
    expect(await readdir(service.skillsDir)).toEqual([first.contentHash]);
  });

  it('reuses a tree already stored under the same hash', async () => {
    const first = await validate(await invoiceMethodZip());
    const row = await service.confirm(first.token!);
    // The row goes (deleting an unused skill stays possible); its tree stays.
    await t.db.delete(skills);
    const again = await validate(await invoiceMethodZip());
    expect(again.outcome).toBe('valid');
    const stored = await service.confirm(again.token!);
    expect(stored.contentHash).toBe(row.contentHash);
    expect(await readdir(service.skillsDir)).toEqual([row.contentHash]);
    expect(await readdir(uploads.root)).toEqual([]);
  });
});

describe('SkillsService: conflict and new_version', () => {
  it('compares name and version with the stored skills', async () => {
    const original = await validate(await invoiceMethodZip());
    const stored = await service.confirm(original.token!);
    const existing = { id: stored.id, version: '1.0.0', contentHash: stored.contentHash };

    // The same zip again: same name, version and hash.
    const same = await validate(await invoiceMethodZip());
    expect(same).toMatchObject({ outcome: 'conflict', token: null, existing });
    expect(same.problems).toEqual([
      {
        title: 'Already uploaded.',
        detail: 'invoice-method 1.0.0 is stored with exactly this content.',
      },
    ]);
    expect(same.checks).toContainEqual({ label: 'version', value: '1.0.0', ok: false });

    // Same name and version, other content: bump the version.
    const edited = await validate(await invoiceMethodZip({}, [{ path: 'new.md', content: 'n\n' }]));
    expect(edited).toMatchObject({ outcome: 'conflict', token: null, existing });
    expect(edited.problems).toEqual([
      {
        title: 'Version 1.0.0 already exists with a different hash.',
        detail: 'Bump version: in SKILL.md.',
      },
    ]);
    expect(await readdir(uploads.root)).toEqual([]);

    // A new version: confirmable, and it follows the newest stored one.
    const bumped = await validate(await invoiceMethodZip({ version: '1.1.0' }));
    expect(bumped).toMatchObject({ outcome: 'new_version', existing, version: '1.1.0' });
    expect(bumped.token).not.toBeNull();
    const next = await service.confirm(bumped.token!);
    expect(next).toMatchObject({ name: 'invoice-method', version: '1.1.0' });

    const third = await validate(await invoiceMethodZip({ version: '2.0.0' }));
    expect(third.existing).toEqual({
      id: next.id,
      version: '1.1.0',
      contentHash: next.contentHash,
    });
  });
});

describe('SkillsService reads', () => {
  it('lists every version with "Used by" from latest configuration versions only', async () => {
    const v1 = await service.confirm((await validate(await invoiceMethodZip())).token!);
    const v2 = await service.confirm(
      (await validate(await invoiceMethodZip({ version: '1.1.0' }))).token!,
    );
    const other = await service.confirm(
      (await validate(await invoiceMethodZip({ name: 'audit-trail' }))).token!,
    );
    // with-skill moved from 1.0.0 to 1.1.0; alpha still uses both versions.
    const withSkill = await seedConfiguration(t.db, 'with-skill', [
      { skillIds: [v1.id] },
      { skillIds: [v2.id] },
    ]);
    const alpha = await seedConfiguration(t.db, 'alpha', [{ skillIds: [v1.id, v2.id] }]);
    await seedConfiguration(t.db, 'baseline', [{}]);

    const rows = SkillRowSchema.array().parse(await service.list());
    expect(rows.map((r) => [r.name, r.version, r.usedBy.map((u) => u.name)])).toEqual([
      ['audit-trail', '1.0.0', []],
      ['invoice-method', '1.1.0', ['alpha', 'with-skill']],
      ['invoice-method', '1.0.0', ['alpha']],
    ]);
    expect(rows[1]!.usedBy).toEqual([
      { configurationId: alpha, name: 'alpha' },
      { configurationId: withSkill, name: 'with-skill' },
    ]);
    expect(rows[0]!.id).toBe(other.id);
    expect(await service.count()).toBe(3);

    const detail = SkillDetailSchema.parse(await service.detail(v2.id));
    expect(detail.usedBy.map((u) => u.name)).toEqual(['alpha', 'with-skill']);
  });

  it('returns the file tree, SKILL.md split, single files and the zip', async () => {
    const row = await service.confirm((await validate(await invoiceMethodZip())).token!);
    const detail = SkillDetailSchema.parse(await service.detail(row.id));
    expect(detail.files).toEqual([
      { path: 'SKILL.md', sizeBytes: Buffer.byteLength(skillMd()), kind: 'markdown' },
      { path: 'checklist.csv', sizeBytes: 42, kind: 'csv' },
      { path: 'examples/reconcile.py', sizeBytes: 19, kind: 'code' },
      { path: 'logo.bin', sizeBytes: 5, kind: 'binary' },
    ]);
    expect(detail.skillMd).toEqual({
      frontMatter:
        'name: invoice-method\nversion: 1.0.0\ndescription: Method for reconciling vendor invoices',
      body: '# Invoice method\n\nMatch every invoice to its purchase order.\n',
    });

    const script = SkillFileContentSchema.parse(
      await service.file(row.id, 'examples/reconcile.py'),
    );
    expect(script).toEqual({
      path: 'examples/reconcile.py',
      kind: 'code',
      sizeBytes: 19,
      content: 'print("reconcile")\n',
      sha256: sha('print("reconcile")\n'),
    });
    const binary = SkillFileContentSchema.parse(await service.file(row.id, 'logo.bin'));
    expect(binary).toMatchObject({ kind: 'binary', content: null, sizeBytes: 5 });

    for (const path of ['examples', '../SKILL.md', 'missing.md', '/etc/passwd']) {
      expect(await httpFailure(service.file(row.id, path))).toMatchObject({ status: 404 });
    }
    expect(await httpFailure(service.detail('skl_missing'))).toEqual({
      status: 404,
      body: { statusCode: 404, message: 'skill skl_missing not found' },
    });

    // The download unpacks to the same content hash.
    const { stream, filename } = await service.zip(row.id);
    expect(filename).toBe('invoice-method-1.0.0.zip');
    const zipPath = join(dataDir, 'download.zip');
    await writeFile(zipPath, await collect(stream));
    const dest = await mkdtemp(join(dataDir, 'unzipped-'));
    const unpacked = await unpackSkillZip(zipPath, dest);
    expect(unpacked.ok).toBe(true);
    expect(unpacked.ok && skillContentHash(unpacked.files)).toBe(row.contentHash);
  });

  it('answers 500 when a stored tree is missing from DATA_DIR', async () => {
    const row = await service.confirm((await validate(await invoiceMethodZip())).token!);
    await rm(service.treePath(row.contentHash), { recursive: true });
    expect(await httpFailure(service.detail(row.id))).toMatchObject({ status: 500 });
  });
});
