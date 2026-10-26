/**
 * readSuiteZip against suite zips built here: the layouts it accepts, what
 * each file becomes in the draft, the scripts it lists (R7), and every
 * refusal, with nothing stored when the zip would fail a reload.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UploadProblemSchema } from '@hermes-evals/shared';
import { BlobStore } from '../../storage/blob-store.js';
import { readSuiteZip, type SuiteZipRead } from './parsers.js';
import { readSuiteZipFile } from './suite-zip.js';
import { SUITE_ZIP_LIMITS } from './zip-entries.js';
import {
  buildZip,
  patchCentral,
  patchName,
  PROMPT,
  REFERENCE,
  SUITE_YAML,
  TASK_YAML,
  vendorStatements,
  type ZipItem,
} from './zip-testing.helper-spec.js';

const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

let work: string;
let blobs: BlobStore;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'suite-zip-'));
  blobs = new BlobStore(join(work, 'data'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function read(zip: Buffer, limits = SUITE_ZIP_LIMITS): Promise<SuiteZipRead> {
  const path = join(work, 'upload.zip');
  await writeFile(path, zip);
  return readSuiteZipFile(path, blobs, { limits });
}

const readItems = async (items: ZipItem[]) => read(await buildZip(items));

function contentsOf(result: SuiteZipRead) {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.problems)}`);
  return result.contents;
}

function problemsOf(result: SuiteZipRead) {
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  for (const problem of result.problems) UploadProblemSchema.parse(problem);
  return result.problems;
}

/** Blobs in the store: nothing is stored when the zip is refused before step 4. */
const storedBlobs = async () => (await readdir(join(work, 'data', 'blobs')).catch(() => [])).length;

describe('accepted layouts', () => {
  it('reads suite.yaml and each task: texts verbatim, other files by blob and kind', async () => {
    const contents = contentsOf(await readItems(vendorStatements()));
    expect(contents.suiteYaml).toBe(SUITE_YAML);
    expect(contents.suite).toEqual({
      name: 'vendor-statements-v1',
      versionLabel: '0.1',
      description: null,
    });
    expect(contents.scripts).toEqual([]);
    expect(contents.tasks).toEqual([
      {
        key: 'unmatched_lines',
        taskYaml: TASK_YAML,
        prompt: PROMPT,
        reference: REFERENCE,
        rubrics: {},
        files: [
          {
            path: 'fixtures/ledger.csv',
            kind: 'fixture',
            sha256: sha('line,amount\nS-101,10\n'),
            size: 21,
          },
          {
            path: 'fixtures/statement.csv',
            kind: 'fixture',
            sha256: sha('line,amount\nS-104,12\n'),
            size: 21,
          },
        ],
      },
    ]);
    expect(contents.fileCount).toBe(6);
    expect(await blobs.read(sha('line,amount\nS-101,10\n'))).toEqual(
      Buffer.from('line,amount\nS-101,10\n'),
    );
  });

  it('is what readSuiteZip, the seam, returns', async () => {
    const path = join(work, 'seam.zip');
    await writeFile(path, await buildZip(vendorStatements()));
    expect((await readSuiteZip(path, blobs)).ok).toBe(true);
  });

  it('strips one folder that holds everything, and leaves out what a reload skips', async () => {
    const contents = contentsOf(
      await readItems(
        vendorStatements('vendor-statements-v1/', [
          { path: 'vendor-statements-v1/', folder: true },
          { path: 'vendor-statements-v1/README.md', content: '# Notes\n' },
          { path: 'vendor-statements-v1/.git/config', content: '[core]\n' },
          { path: 'vendor-statements-v1/unmatched_lines/.DS_Store', content: 'finder' },
          { path: 'vendor-statements-v1/unmatched_lines/fixtures/.hidden.csv', content: 'x' },
          { path: '__MACOSX/vendor-statements-v1/._suite.yaml', content: 'apple double' },
        ]),
      ),
    );
    expect(contents.tasks[0]!.files.map((f) => f.path)).toEqual([
      'fixtures/ledger.csv',
      'fixtures/statement.csv',
    ]);
    expect(contents.fileCount).toBe(6);
  });

  it('gives every file the loader kind, lists verify/ as scripts and keeps odd bytes as they are', async () => {
    const taskYaml = `${TASK_YAML}  - key: judged
    type: llm_judge
    params: { rubric: rubric.md }
  - key: checked
    type: verifier_script
    params: { script: check.py }
self_check:
  expected_workspace: expected
  expected_home: expected_home
`;
    const bomPrompt = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PROMPT)]);
    const latin1 = Buffer.from('caf\xe9\n', 'latin1');
    const contents = contentsOf(
      await readItems([
        { path: 'suite.yaml', content: SUITE_YAML },
        { path: 'unmatched_lines/task.yaml', content: taskYaml },
        { path: 'unmatched_lines/prompt.md', content: bomPrompt },
        { path: 'unmatched_lines/reference.json', content: latin1 },
        { path: 'unmatched_lines/rubric.md', content: 'Be fair.\n' },
        { path: 'unmatched_lines/notes.txt', content: 'kept as is\n' },
        { path: 'unmatched_lines/fixtures/statement.csv', content: 'a\n' },
        { path: 'unmatched_lines/expected/out.csv', content: 'b\n' },
        { path: 'unmatched_lines/expected_home/memories/USER.md', content: 'c\n' },
        { path: 'unmatched_lines/home/memories/MEMORY.md', content: 'd\n' },
        { path: 'unmatched_lines/verify/check.py', content: 'print(1)\n' },
        { path: 'unmatched_lines/verify/data.json', content: '{}\n' },
        { path: 'other_task/prompt.md', content: 'no task.yaml\n' },
      ]),
    );
    const [task, other] = contents.tasks;
    expect(task!.prompt).toBe(`\uFEFF${PROMPT}`);
    expect(task!.reference).toBeNull();
    expect(task!.rubrics).toEqual({ 'rubric.md': 'Be fair.\n' });
    expect(task!.files.map(({ path, kind }) => [path, kind])).toEqual([
      ['expected/out.csv', 'expected'],
      ['expected_home/memories/USER.md', 'expected_home'],
      ['fixtures/statement.csv', 'fixture'],
      ['home/memories/MEMORY.md', 'home_seed'],
      ['notes.txt', 'other'],
      ['reference.json', 'other'],
      ['verify/check.py', 'verifier'],
      ['verify/data.json', 'verifier'],
    ]);
    expect(contents.scripts).toEqual([
      { path: 'unmatched_lines/verify/check.py', sizeBytes: 9, sha256: sha('print(1)\n') },
      { path: 'unmatched_lines/verify/data.json', sizeBytes: 3, sha256: sha('{}\n') },
    ]);
    // A folder suite.yaml does not list comes after the listed ones; it is kept, invalid.
    expect(other).toMatchObject({ key: 'other_task', taskYaml: null, prompt: 'no task.yaml\n' });
  });

  it('lists a Verify/ folder as code too, kept as a plain file', async () => {
    const contents = contentsOf(
      await readItems(
        vendorStatements('', [{ path: 'unmatched_lines/Verify/check.py', content: 'print(1)\n' }]),
      ),
    );
    expect(contents.scripts.map((s) => s.path)).toEqual(['unmatched_lines/Verify/check.py']);
    expect(contents.tasks[0]!.files.find((f) => f.path === 'Verify/check.py')?.kind).toBe('other');
  });

  it('keeps an empty task folder as a task, as the walk would list it', async () => {
    const contents = contentsOf(
      await readItems(vendorStatements('top/', [{ path: 'top/empty_task/', folder: true }])),
    );
    expect(contents.tasks.map((t) => t.key)).toEqual(['unmatched_lines', 'empty_task']);
  });

  it('keeps a task suite.yaml lists without a folder, as a reload would', async () => {
    const yaml = 'name: s\nversion_label: "1"\ntasks: [ghost, unmatched_lines]\n';
    const items = vendorStatements().map((i) =>
      i.path === 'suite.yaml' ? { ...i, content: yaml } : i,
    );
    const contents = contentsOf(await readItems(items));
    expect(contents.tasks.map((t) => t.key)).toEqual(['ghost', 'unmatched_lines']);
    expect(contents.tasks[0]).toEqual({
      key: 'ghost',
      taskYaml: null,
      prompt: null,
      reference: null,
      rubrics: {},
      files: [],
    });
  });
});

describe('refusals of the zip itself', () => {
  it('refuses what is not a zip', async () => {
    expect(problemsOf(await read(Buffer.from('not a zip')))[0]!.title).toBe('Not a zip file.');
  });

  it('refuses more than 20,000 entries before reading any', async () => {
    const items: ZipItem[] = Array.from({ length: 20_001 }, (_, i) => ({
      path: `t/f${i}/`,
      folder: true,
    }));
    expect(problemsOf(await readItems(items))).toEqual([
      {
        title: 'Over 20,000 files.',
        detail:
          'A suite holds at most 20,000 files, 25 MB each, in folders at most 12 levels deep.',
      },
    ]);
  });

  it('refuses a symbolic link, with the board wording', async () => {
    const zip = await buildZip(
      vendorStatements('', [
        { path: 'total_due/fixtures/data.csv', content: '/etc/passwd', mode: 0o120777 },
      ]),
    );
    expect(problemsOf(await read(zip))).toEqual([
      {
        title: 'The zip has a symbolic link at total_due/fixtures/data.csv.',
        detail:
          'Links are not allowed. Replace the link with the file itself, then zip the folder again.',
      },
    ]);
    expect(await storedBlobs()).toBe(0);
  });

  it('refuses a device, FIFO or socket', async () => {
    const zip = await buildZip(
      vendorStatements('', [{ path: 'pipe', content: '', mode: 0o010644 }]),
    );
    expect(problemsOf(await read(zip))[0]!.title).toBe('The zip has a special file at pipe.');
  });

  it.each([
    ['xx/secrets.txt', '../secrets.txt'],
    ['xetc/passwd', '/etc/passwd'],
    ['xx/x', 'C:/x'],
  ])('refuses %s patched to %s, a path outside the suite', async (from, to) => {
    const zip = patchName(
      await buildZip(vendorStatements('', [{ path: from, content: 'x' }])),
      from,
      to,
    );
    expect(problemsOf(await read(zip))).toEqual([
      {
        title: `${to} points outside the suite.`,
        detail: 'Paths in the zip must be relative and stay inside the suite folder.',
      },
    ]);
  });

  it('refuses backslashes, control characters, empty segments and long names', async () => {
    const long = `a/${'n'.repeat(256)}`;
    const zip = patchName(
      patchName(
        patchName(
          await buildZip(
            vendorStatements('', [
              { path: 'a/bxc', content: '1' },
              { path: 'a/dxe', content: '2' },
              { path: 'a/fx/g', content: '3' },
              { path: long, content: '4' },
            ]),
          ),
          'a/bxc',
          'a/b\\c',
        ),
        'a/dxe',
        'a/d\u0001e',
      ),
      'a/fx/g',
      'a//x/g',
    );
    expect(problemsOf(await read(zip)).map((p) => p.title)).toEqual([
      'a/b\\c uses a backslash.',
      'a/d\\x01e contains a control character.',
      'a//x/g has an empty or "." path segment.',
      `${long.slice(0, 157)}... has a name over 255 bytes.`,
    ]);
  });

  it('refuses a file more than 12 folders deep', async () => {
    const deep = `t/${'d/'.repeat(12)}f.txt`;
    expect(
      problemsOf(await readItems(vendorStatements('', [{ path: deep, content: 'x' }]))),
    ).toEqual([
      {
        title: `${deep} is more than 12 folders deep.`,
        detail:
          'A suite holds at most 20,000 files, 25 MB each, in folders at most 12 levels deep.',
      },
    ]);
  });

  it('refuses a file over 25 MB', async () => {
    const big = Buffer.alloc(25 * 1024 * 1024 + 1);
    const zip = await buildZip(
      vendorStatements('', [{ path: 't/fixtures/big.bin', content: big, compress: false }]),
    );
    expect(problemsOf(await read(zip))[0]).toEqual({
      title: 't/fixtures/big.bin is 25 MB, over 25 MB.',
      detail: 'A suite holds at most 20,000 files, 25 MB each, in folders at most 12 levels deep.',
    });
  });

  it('refuses a size header that lies, while reading', async () => {
    const zip = patchCentral(
      await buildZip(
        vendorStatements('', [
          { path: 't/fixtures/a.txt', content: 'x'.repeat(100), compress: false },
        ]),
      ),
      't/fixtures/a.txt',
      (header) => header.writeUInt32LE(10, 24),
    );
    const [problem] = problemsOf(await read(zip));
    expect(problem!.title).toBe('Corrupt zip.');
  });

  it('refuses a running total over the unpacked cap', async () => {
    const zip = await buildZip(vendorStatements());
    const problems = problemsOf(await read(zip, { ...SUITE_ZIP_LIMITS, maxUnpackedBytes: 100 }));
    expect(problems[0]!.title).toBe('Too large unpacked.');
  });

  it('refuses an entry that expands more than 200 times', async () => {
    const zip = await buildZip(
      vendorStatements('', [{ path: 't/zeros.bin', content: Buffer.alloc(4 * 1024 * 1024) }]),
    );
    expect(problemsOf(await read(zip))[0]!.title).toMatch(/^t\/zeros\.bin expands from /);
  });

  it('refuses encryption and compression methods other than deflate and store', async () => {
    const zip = await buildZip(
      vendorStatements('', [
        { path: 't/locked.txt', content: 'x' },
        { path: 't/bzip.txt', content: 'y' },
      ]),
    );
    const patched = patchCentral(
      patchCentral(zip, 't/locked.txt', (h) => h.writeUInt16LE(h.readUInt16LE(8) | 1, 8)),
      't/bzip.txt',
      (h) => h.writeUInt16LE(12, 10),
    );
    expect(problemsOf(await read(patched)).map((p) => p.title)).toEqual([
      't/locked.txt is password-protected.',
      't/bzip.txt uses compression method 12.',
    ]);
  });

  it('refuses two paths that differ only in case, and a path that is a file and a folder', async () => {
    const problems = problemsOf(
      await readItems(
        vendorStatements('', [
          { path: 'Unmatched_lines/x.txt', content: 'x' },
          { path: 'unmatched_lines/notes', content: 'file' },
          { path: 'unmatched_lines/notes/a.txt', content: 'a' },
        ]),
      ),
    );
    expect(problems.map((p) => p.title)).toEqual([
      'unmatched_lines and Unmatched_lines differ only in case.',
      'unmatched_lines/notes is both a file and a folder.',
    ]);
    const twins = problemsOf(
      await readItems([
        ...vendorStatements(),
        { path: 'Unmatched_lines/task.yaml', content: TASK_YAML },
      ]),
    );
    expect(twins[0]!.title).toBe('unmatched_lines and Unmatched_lines differ only in case.');
  });

  it('refuses a path listed twice', async () => {
    const problems = problemsOf(
      await readItems([...vendorStatements(), { path: 'suite.yaml', content: SUITE_YAML }]),
    );
    expect(problems.map((p) => p.title)).toEqual(['suite.yaml is in the zip twice.']);
  });

  it('lists at most ten problems', async () => {
    const links = Array.from({ length: 12 }, (_, i) => ({
      path: `t/l${i}`,
      content: 'x',
      mode: 0o120777,
    }));
    const problems = problemsOf(await readItems(vendorStatements('', links)));
    expect(problems).toHaveLength(10);
    expect(problems[9]!.title).toBe('3 more problems.');
  });
});

describe('refusals a reload would make', () => {
  it.each([
    [[], 'The zip is empty.', 'Zip the suite folder: suite.yaml and one folder per task.'],
    [
      [{ path: 'a/b/suite.yaml', content: SUITE_YAML }],
      'No suite.yaml at the zip root.',
      'Found a/b/suite.yaml, 2 folders down. Zip the suite folder itself.',
    ],
    [
      [{ path: 'Suite.yml', content: SUITE_YAML }],
      'No suite.yaml at the zip root.',
      'Found Suite.yml; name it suite.yaml.',
    ],
  ] as const)(
    'refuses a zip without suite.yaml where it belongs (%#)',
    async (items, title, detail) => {
      expect(problemsOf(await readItems([...items]))).toEqual([{ title, detail }]);
    },
  );

  it.each([
    [
      'name: vendor-statements-v1\n',
      {
        title: 'suite.yaml: version_label is required.',
        detail: 'Add a label such as version_label: "0.1", then zip the folder again.',
      },
    ],
    [
      'version_label: "0.1"\n',
      {
        title: 'suite.yaml: name is required.',
        detail:
          'Add the suite name, such as name: vendor-statements-v1, then zip the folder again.',
      },
    ],
    [
      'name: x\nversion_label: 1\nversion_label: 2\n',
      {
        title: 'suite.yaml line 3: Map keys must be unique',
        detail: 'Fix it, then zip the folder again.',
      },
    ],
    [
      'name: x\nversion_label: "1"\nowner: me\n',
      {
        title: 'suite.yaml line 3: owner: Unrecognized key: "owner"',
        detail: 'Fix it, then zip the folder again.',
      },
    ],
  ])('refuses suite.yaml %j with the loader rule, storing nothing', async (yaml, problem) => {
    const items = vendorStatements().map((i) =>
      i.path === 'suite.yaml' ? { ...i, content: yaml } : i,
    );
    expect(problemsOf(await readItems(items))).toEqual([problem]);
    expect(await storedBlobs()).toBe(0);
  });

  it('refuses a task folder whose name is not a folder name', async () => {
    const problems = problemsOf(
      await readItems(vendorStatements('', [{ path: 'my task/prompt.md', content: 'x' }])),
    );
    expect(problems).toEqual([
      {
        title: 'Task folder name "my task" is not allowed.',
        detail:
          'Use letters, digits, ., _ and -, starting with a letter or digit. Rename the folder, then zip the suite again.',
      },
    ]);
  });

  it('refuses a task.yaml that does not parse, with its file and line, storing nothing', async () => {
    const items = vendorStatements('', [
      { path: 'second/task.yaml', content: 'summary: x\nlimits: [\n' },
    ]);
    const problems = problemsOf(await readItems(items));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.title).toMatch(/^second\/task\.yaml line \d+: /);
    expect(await storedBlobs()).toBe(0);
  });

  it('refuses self-checks that could outlast one load', async () => {
    const checks = Array.from(
      { length: 6 },
      (_, i) =>
        `  - key: v${i}\n    type: verifier_script\n    params: { script: check.py, timeout_s: 300 }\n`,
    ).join('');
    const yaml = `${TASK_YAML}${checks}self_check:\n  expected_workspace: expected\n`;
    const items = vendorStatements('', [
      { path: 'unmatched_lines/verify/check.py', content: 'print(1)\n' },
      { path: 'unmatched_lines/expected/out.txt', content: 'x' },
    ]).map((i) => (i.path === 'unmatched_lines/task.yaml' ? { ...i, content: yaml } : i));
    expect(problemsOf(await readItems(items))[0]).toEqual({
      title: 'The self-checks may take too long.',
      detail:
        'They may take up to 3720 s, above the 3600 s one load may take. Lower timeout_s or split the suite, then zip it again.',
    });
  });
});
