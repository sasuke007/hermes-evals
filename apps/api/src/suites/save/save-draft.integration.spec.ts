/**
 * Saving a draft (plan 4.6, section 16's suite-authoring row) on PGlite with
 * the real loader and a fresh SUITES_DIR: the unchanged round trip of the
 * five committed suites (on copies), a new version and what it rewrites, the
 * files the draft does not manage, a removed task, a new suite (a zip's
 * suite.yaml kept as it was), the steps it reports, and a save whose claim
 * is not the draft's.
 */
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { DraftSaveResultSchema } from '@hermes-evals/shared';
import { suiteDrafts, suites, tasks } from '../../database/schema/index.js';
import {
  configOf,
  silentLogger,
  uploadedFile,
} from '../../resources/skills/testing.helper-spec.js';
import type { StorageService } from '../../storage/storage.service.js';
import { SuiteDraftsService } from '../drafts/drafts.service.js';
import { SuiteImportStore } from '../import/suite-import.store.js';
import { SuiteZipImports } from '../import/suite-zip-imports.js';
import { buildZip, vendorStatements } from '../import/zip-testing.helper-spec.js';
import { FIVE, SaveWorld } from './save-world.support-spec.js';

vi.setConfig({ testTimeout: 120_000 });

let world: SaveWorld;

afterEach(async () => {
  await world?.close();
});

const saved = (output: Awaited<ReturnType<SaveWorld['save']>>) => {
  if (output.kind !== 'saved') throw new Error(`not saved: ${JSON.stringify(output)}`);
  return DraftSaveResultSchema.parse(output.result);
};

describe('the round trip', () => {
  it('opens each committed suite as a draft and saves it unchanged, touching no file', async () => {
    world = await SaveWorld.create({ committed: FIVE });
    for (const folder of FIVE) {
      const loaded = await world.load(folder);
      expect(loaded.outcome, `${folder}: ${loaded.message}`).toBe('created');
      const before = await world.snapshot();
      const draft = await world.open(folder);
      expect(draft.baseSuiteId).toBe(loaded.suiteId);

      const result = saved(await world.save(folder));
      expect(result).toMatchObject({
        outcome: 'unchanged',
        suite: { suiteId: loaded.suiteId, versionNumber: 1 },
        changes: { added: [], removed: [], changed: [], nowInvalid: [], nowValid: [] },
      });
      expect(result.validCount).toBe(result.taskCount);
      expect(await world.snapshot(), folder).toEqual(before);
      const drafts = await world.t.db.select().from(suiteDrafts);
      expect(drafts).toEqual([]);
    }
  });
});

describe('a saved edit', () => {
  beforeEach(async () => {
    world = await SaveWorld.create();
    // Files the draft never manages, and a hand-written comment in suite.yaml.
    const suite = join(world.suitesDir, 'complete');
    await writeFile(join(suite, 'README.md'), 'Kept as written.\n');
    await writeFile(join(suite, '.notes'), 'hidden\n');
    await writeFile(join(suite, 'answer_verifier', 'NOTES.txt'), 'task notes\n');
    await symlink('../README.md', join(suite, 'answer_verifier', 'readme-link.md'));
    const yaml = await readFile(join(suite, 'suite.yaml'), 'utf8');
    await writeFile(join(suite, 'suite.yaml'), `# Maintained by hand.\n${yaml}`);
    await world.load('complete');
  });

  async function edit(key: string, change: (prompt: string) => string): Promise<void> {
    await world.writer.write('complete', undefined, async (ctx) => {
      const task = ctx.task(key);
      await ctx.change(task, { prompt: change(task.prompt ?? '') });
    });
  }

  it('creates the next version with only that task changed, keeping every file it does not manage', async () => {
    const before = await world.snapshot();
    await world.open('complete');
    await edit('answer_verifier', (prompt) => `${prompt}\nShow your working.\n`);
    await world.label('complete', '1.1');

    const result = saved(await world.save('complete'));
    expect(result).toMatchObject({
      outcome: 'created',
      suite: { versionNumber: 2, versionLabel: '1.1' },
      changes: { added: [], removed: [], changed: ['answer_verifier'] },
      taskCount: 5,
      validCount: 5,
      invalid: [],
    });

    const after = await world.snapshot();
    const changed = Object.keys(after).filter((path) => after[path] !== before[path]);
    expect(changed.sort()).toEqual(['complete/answer_verifier/prompt.md', 'complete/suite.yaml']);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after['complete/answer_verifier/readme-link.md']).toBe('link → ../README.md');
    const yaml = await readFile(join(world.suitesDir, 'complete', 'suite.yaml'), 'utf8');
    expect(yaml.startsWith('# Maintained by hand.\n')).toBe(true);
    expect(yaml).toContain("version_label: '1.1'");
    // Nothing left in SUITES_DIR but the suites.
    expect(Object.keys(after).some((p) => p.startsWith('.draft-'))).toBe(false);
  });

  it('saves a task with problems as invalid, as on disk, without blocking the save', async () => {
    await world.open('complete');
    await world.writer.write('complete', undefined, async (ctx) => {
      await ctx.change(ctx.task('numeric'), { reference: '{ "sum": 10.5 }\n' });
    });
    const result = saved(await world.save('complete'));
    expect(result).toMatchObject({
      outcome: 'created',
      suite: { versionNumber: 2 },
      changes: { changed: ['numeric'], nowInvalid: ['numeric'] },
      taskCount: 5,
      validCount: 4,
      invalid: [
        {
          key: 'numeric',
          reason:
            'answer (numeric_tolerance) self-check error: the reference has no value at total',
        },
      ],
    });
    expect(
      await readFile(join(world.suitesDir, 'complete', 'numeric', 'reference.json'), 'utf8'),
    ).toBe('{ "sum": 10.5 }\n');
    const [row] = await world.t.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.suiteId, result.suite.suiteId), eq(tasks.key, 'numeric')));
    expect(row).toMatchObject({ valid: false, invalidReason: result.invalid[0]!.reason });
  });

  it('removes the folder of a removed task and its line in suite.yaml', async () => {
    await world.open('complete');
    await world.writer.write('complete', undefined, async (ctx) => {
      await ctx.change(ctx.task('exact'), { removed: true });
    });
    const result = saved(await world.save('complete'));
    expect(result.changes.removed).toEqual(['exact']);
    expect(result.taskCount).toBe(4);
    const after = await world.snapshot();
    expect(Object.keys(after).some((p) => p.startsWith('complete/exact/'))).toBe(false);
    const yaml = await readFile(join(world.suitesDir, 'complete', 'suite.yaml'), 'utf8');
    expect(yaml).toContain('tasks: [numeric, json_unordered, summary_file, answer_verifier]');
    // The version it replaced still holds the task.
    const versions = await world.t.db
      .select()
      .from(suites)
      .where(eq(suites.sourcePath, 'complete'));
    expect(versions.map((v) => v.taskCount).sort((a, b) => a - b)).toEqual([4, 5]);
  });

  it('reports its steps, self-checks counted, while it runs', async () => {
    await world.open('complete');
    await edit('numeric', (prompt) => `${prompt}\n`);
    saved(await world.save('complete'));
    const steps = world.progress.map((p) => p.progress.step);
    expect(steps[0]).toBe('staging');
    expect(steps[1]).toBe('loading');
    expect(steps.at(-1)).toBe('moving');
    const counted = world.progress.filter((p) => p.progress.step === 'self_checks');
    expect(counted.at(-1)!.progress.selfChecks).toEqual({ done: 5, total: 5 });
  });

  it('acts only on the claim it was sent for', async () => {
    await world.open('complete');
    const job = await world.claim('complete');
    const stale = { ...job, claim: new Date(Date.parse(job.claim) - 1000).toISOString() };
    expect(await world.save('complete', stale)).toEqual({ kind: 'gone' });
    saved(await world.save('complete', job));
    // The draft is gone: a second job for the same claim finds nothing to save.
    expect(await world.save('complete', job)).toEqual({ kind: 'gone' });
  });
});

describe('a new suite', () => {
  it('copies a suite with its verifier scripts and saves it as v1 of a new folder', async () => {
    world = await SaveWorld.create();
    await world.load('complete');
    await world.open('zz-smoke-copy', 'complete');
    const result = saved(await world.save('zz-smoke-copy'));
    expect(result).toMatchObject({
      outcome: 'created',
      suite: { name: 'zz-smoke-copy', versionNumber: 1, versionLabel: '0.1' },
      taskCount: 5,
      validCount: 5,
    });
    const after = await world.snapshot();
    const copied = (p: string) => p.replace(/^zz-smoke-copy\//, 'complete/');
    for (const path of Object.keys(after).filter((p) => p.startsWith('zz-smoke-copy/'))) {
      if (path.endsWith('suite.yaml')) continue;
      expect(after[path], path).toBe(after[copied(path)]);
    }
    expect(after['zz-smoke-copy/answer_verifier/verify/check_count.py']).toBeDefined();
    expect(after['zz-smoke-copy/summary_file/verify/check_summary.py']).toBeDefined();
  });

  it("keeps a zip's suite.yaml as the zip held it, comments and folding, patching only a new name", async () => {
    world = await SaveWorld.create();
    const zipped = [
      '# Vendor statements, as the finance team keeps them.',
      'name: zz-smoke-zip',
      "version_label: '0.1' # the first cut",
      'description: >-',
      '  Statements matched',
      '  line by line.',
      'tasks:',
      '  - one # the only task so far',
      '',
    ].join('\n');
    for (const name of ['zz-smoke-zip', 'zz-smoke-zip-renamed']) {
      await world.writer.create(
        {
          sourcePath: name,
          name,
          origin: 'zip',
          versionLabel: '0.1',
          description: 'Statements matched line by line.',
          suiteYaml: zipped,
        },
        async (ctx) => {
          const one = { key: 'one', taskYaml: null, prompt: 'Say hi.', reference: '1' };
          await ctx.insert({ ...one, rubrics: {}, files: [] }, {});
        },
      );
      expect(saved(await world.save(name))).toMatchObject({ outcome: 'created' });
    }
    const onDisk = (name: string) => readFile(join(world.suitesDir, name, 'suite.yaml'), 'utf8');
    expect(await onDisk('zz-smoke-zip')).toBe(zipped);
    expect(await onDisk('zz-smoke-zip-renamed')).toBe(
      zipped.replace('name: zz-smoke-zip\n', 'name: zz-smoke-zip-renamed\n'),
    );
  });

  it("keeps a zip's suite.yaml from validation through POST /suites/drafts to the saved folder", async () => {
    world = await SaveWorld.create();
    const zipped = [
      '# Vendor statements, as the finance team keeps them.',
      'name: zz-smoke-zipped',
      "version_label: '0.1' # the first cut",
      'description: >-',
      '  Statements matched',
      '  line by line.',
      'tasks:',
      '  - unmatched_lines # the only task so far',
      '',
    ].join('\n');
    const storage = world.store as unknown as StorageService;
    const store = new SuiteImportStore(
      storage,
      configOf({ SKILL_UPLOAD_TTL_S: 1800 }),
      silentLogger,
    );
    const zips = new SuiteZipImports(world.t.db, storage, store, silentLogger);
    const items = vendorStatements().map((item) =>
      item.path === 'suite.yaml' ? { ...item, content: zipped } : item,
    );
    const validation = await zips.validate(
      await uploadedFile(world.store, await buildZip(items), 'statements.zip'),
    );
    expect(validation.outcome).toBe('valid');
    await new SuiteDraftsService(world.t.db, storage, zips).create({
      name: 'zz-smoke-zipped',
      versionLabel: '0.1',
      from: { kind: 'zip', token: validation.token!, trustScripts: false },
    });
    expect((await world.draft('zz-smoke-zipped')).suiteYaml).toBe(zipped);

    expect(saved(await world.save('zz-smoke-zipped'))).toMatchObject({ outcome: 'created' });
    expect(await readFile(join(world.suitesDir, 'zz-smoke-zipped', 'suite.yaml'), 'utf8')).toBe(
      zipped,
    );
  });

  it('is not saved when its folder appeared on disk meanwhile', async () => {
    world = await SaveWorld.create();
    await world.writer.create(
      { sourcePath: 'zz-smoke-new', name: 'zz-smoke-new', origin: 'empty', versionLabel: '0.1' },
      async () => {},
    );
    await world.writer.write('zz-smoke-new', undefined, async (ctx) => {
      await ctx.insert(
        {
          key: 'one',
          taskYaml: null,
          prompt: 'Say hi.',
          reference: '1',
          rubrics: {},
          files: [],
        },
        {},
      );
    });
    await writeFile(join(world.suitesDir, 'zz-smoke-new'), 'a file in the way\n');
    const before = await world.snapshot();
    const output = await world.save('zz-smoke-new');
    expect(output).toMatchObject({
      kind: 'not_saved',
      step: 'staging',
      error: { message: './suites/zz-smoke-new already exists; give the new suite another name' },
    });
    expect(await world.snapshot()).toEqual(before);
    expect((await world.draft('zz-smoke-new')).saveStartedAt).toBeNull();
  });
});
