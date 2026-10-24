/**
 * unpackSkillZip against hostile archives built here. yazl writes valid zips
 * (and any unix mode, so links and devices); names yazl refuses to write
 * (absolute, '..', backslash) are patched into its output byte for byte,
 * as is a lying size header.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatBytes } from './format.js';
import { buildZip } from './testing.helper-spec.js';
import { SKILL_ZIP_LIMITS, unpackSkillZip, type UnpackResult } from './zip-reader.js';

/** Replaces every occurrence of a name with one of the same byte length. */
function patchName(zip: Buffer, from: string, to: string): Buffer {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const out = Buffer.from(zip);
  const needle = Buffer.from(from);
  let at = out.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  while (at >= 0) {
    Buffer.from(to).copy(out, at);
    at = out.indexOf(needle, at + needle.length);
  }
  return out;
}

const CENTRAL_HEADER = 0x02014b50;

/** Applies `patch` to the central directory header of the entry named `name`. */
function patchCentral(zip: Buffer, name: string, patch: (header: Buffer) => void): Buffer {
  const out = Buffer.from(zip);
  for (let at = 0; at < out.length - 46; at++) {
    if (out.readUInt32LE(at) !== CENTRAL_HEADER) continue;
    const nameLength = out.readUInt16LE(at + 28);
    if (out.subarray(at + 46, at + 46 + nameLength).toString() === name) {
      patch(out.subarray(at, at + 46));
      return out;
    }
  }
  throw new Error(`no central header for ${name}`);
}

const SKILL_MD = `---
name: invoice-method
version: 1.0.0
description: Method for reconciling vendor invoices
---

# Invoice method
`;

const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

let work: string;
let dest: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'zip-reader-'));
  dest = join(work, 'dest');
  await mkdir(dest);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function unpack(zip: Buffer, limits = SKILL_ZIP_LIMITS): Promise<UnpackResult> {
  const path = join(work, 'upload.zip');
  await writeFile(path, zip);
  return unpackSkillZip(path, dest, limits);
}

/** Every path under dest, files and folders. */
async function written(): Promise<string[]> {
  return (await readdir(dest, { recursive: true })).sort();
}

function problemsOf(result: UnpackResult) {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.problems;
}

describe('unpackSkillZip: accepted layouts', () => {
  it('unpacks a skill with SKILL.md at the root and hashes each file', async () => {
    const script = 'print("reconcile")\n';
    const result = await unpack(
      await buildZip([
        { path: 'SKILL.md', content: SKILL_MD },
        { path: 'examples/', folder: true },
        { path: 'examples/reconcile.py', content: script, compress: false },
        { path: 'checklist.md', content: '# Columns\n' },
      ]),
    );
    expect(result).toEqual({
      ok: true,
      root: '',
      files: [
        { path: 'SKILL.md', size: Buffer.byteLength(SKILL_MD), sha256: sha(SKILL_MD) },
        { path: 'checklist.md', size: 10, sha256: sha('# Columns\n') },
        { path: 'examples/reconcile.py', size: script.length, sha256: sha(script) },
      ],
      unpackedBytes: Buffer.byteLength(SKILL_MD) + 10 + script.length,
    });
    expect(await readFile(join(dest, 'examples/reconcile.py'), 'utf8')).toBe(script);
    expect(await written()).toEqual([
      'SKILL.md',
      'checklist.md',
      'examples',
      'examples/reconcile.py',
    ]);
  });

  it('strips one top-level folder that holds everything, and skips macOS metadata', async () => {
    const result = await unpack(
      await buildZip([
        { path: 'invoice-method/', folder: true },
        { path: 'invoice-method/SKILL.md', content: SKILL_MD },
        { path: 'invoice-method/examples/sample.csv', content: 'a,b\n1,2\n' },
        { path: 'invoice-method/.DS_Store', content: 'finder' },
        { path: '__MACOSX/invoice-method/._SKILL.md', content: 'apple double' },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root).toBe('invoice-method/');
    expect(result.files.map((f) => f.path)).toEqual(['SKILL.md', 'examples/sample.csv']);
    expect(await written()).toEqual(['SKILL.md', 'examples', 'examples/sample.csv']);
  });
});

describe('unpackSkillZip: where SKILL.md is', () => {
  it('refuses SKILL.md two folders down, and says where it is', async () => {
    const problems = problemsOf(
      await unpack(await buildZip([{ path: 'a/b/SKILL.md', content: SKILL_MD }])),
    );
    expect(problems).toEqual([
      {
        title: 'No SKILL.md at the zip root.',
        detail:
          "Found a/b/SKILL.md two folders down. Zip the folder's contents rather than the folder.",
      },
    ]);
    expect(await written()).toEqual([]);
  });

  it('refuses a folder with SKILL.md that has other files beside it', async () => {
    const result = await unpack(
      await buildZip([
        { path: 'invoice-method/SKILL.md', content: SKILL_MD },
        { path: 'README.md', content: '# readme' },
      ]),
    );
    expect(problemsOf(result)[0]?.detail).toBe(
      "Found invoice-method/SKILL.md one folder down, beside other files. Zip the folder's contents rather than the folder.",
    );
    expect(result.ok ? null : result.listing).toEqual([
      { path: 'README.md', sizeBytes: 8 },
      { path: 'invoice-method/SKILL.md', sizeBytes: Buffer.byteLength(SKILL_MD) },
    ]);
  });

  it('names a lower-case skill.md, and an archive without any', async () => {
    expect(
      problemsOf(await unpack(await buildZip([{ path: 'skill.md', content: SKILL_MD }])))[0]
        ?.detail,
    ).toBe('Found skill.md; name it SKILL.md in capitals.');
    expect(problemsOf(await unpack(await buildZip([{ path: 'notes.md' }])))[0]?.detail).toBe(
      'Add a SKILL.md with name, version and description front matter at the top of the zip.',
    );
    expect(
      problemsOf(await unpack(await buildZip([{ path: 'empty/', folder: true }])))[0]?.title,
    ).toBe('The zip is empty.');
  });

  it('refuses a file that is not a zip', async () => {
    const problems = problemsOf(await unpack(randomBytes(4096)));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.title).toBe('Not a zip file.');
  });
});

describe('unpackSkillZip: hostile paths and types', () => {
  it('refuses zip slip with .. and writes nothing, inside or outside', async () => {
    const zip = patchName(
      await buildZip([
        { path: 'SKILL.md', content: SKILL_MD },
        { path: 'xx/evil.txt', content: 'pwned' },
      ]),
      'xx/evil.txt',
      '../evil.txt',
    );
    expect(problemsOf(await unpack(zip))).toEqual([
      {
        title: 'Unsafe path in the zip.',
        detail: '../evil.txt climbs out of the skill folder with "..".',
      },
    ]);
    expect(await written()).toEqual([]);
    expect(await readdir(work)).not.toContain('evil.txt');
  });

  it('refuses absolute paths, drive letters, backslashes and control characters', async () => {
    const zip = await buildZip([
      { path: 'SKILL.md', content: SKILL_MD },
      { path: 'Xetc/passwd' },
      { path: 'Yxwindows.ini' },
      { path: 'dir/file.md' },
      { path: 'bell-Xname.md' },
    ]);
    let patched = patchName(zip, 'Xetc/passwd', '/etc/passwd');
    patched = patchName(patched, 'Yxwindows.ini', 'C:windows.ini');
    patched = patchName(patched, 'dir/file.md', 'dir\\file.md');
    patched = patchName(patched, 'bell-Xname.md', 'bell-\u0007name.md');
    expect(problemsOf(await unpack(patched))).toEqual([
      {
        title: 'Unsafe path in the zip.',
        detail: '/etc/passwd is an absolute path. Zip the skill with relative paths.',
      },
      {
        title: 'Unsafe path in the zip.',
        detail: 'C:windows.ini is an absolute path. Zip the skill with relative paths.',
      },
      {
        title: 'Unsafe path in the zip.',
        detail:
          'dir\\file.md uses a backslash. Zip the folder with a tool that writes "/" separators.',
      },
      {
        title: 'Unsafe name in the zip.',
        detail: 'bell-\\x07name.md contains a control character.',
      },
    ]);
    expect(await written()).toEqual([]);
  });

  it('refuses symbolic links and device files by their unix mode', async () => {
    const problems = problemsOf(
      await unpack(
        await buildZip([
          { path: 'SKILL.md', content: SKILL_MD },
          { path: 'secrets', content: '/etc/shadow', mode: 0o120777 },
          { path: 'tty', content: '', mode: 0o020644 },
          { path: 'pipe', content: '', mode: 0o010644 },
        ]),
      ),
    );
    expect(problems).toEqual([
      {
        title: 'Symbolic link in the zip.',
        detail: 'secrets is a link. Put the file it points to in the zip instead.',
      },
      {
        title: 'Special file in the zip.',
        detail: 'tty is a device, FIFO or socket. Only files and folders are allowed.',
      },
      {
        title: 'Special file in the zip.',
        detail: 'pipe is a device, FIFO or socket. Only files and folders are allowed.',
      },
    ]);
    expect(await written()).toEqual([]);
  });

  it('refuses duplicate entries and a path that is both a file and a folder', async () => {
    const problems = problemsOf(
      await unpack(
        await buildZip([
          { path: 'SKILL.md', content: SKILL_MD },
          { path: 'SKILL.md', content: 'second copy' },
          { path: 'notes', content: 'a file' },
          { path: 'notes/inner.md' },
        ]),
      ),
    );
    expect(problems.map((p) => p.detail)).toEqual([
      'SKILL.md is listed twice.',
      'notes is both a file and a folder.',
    ]);
  });

  it('refuses encrypted entries', async () => {
    const zip = patchCentral(
      await buildZip([{ path: 'SKILL.md', content: SKILL_MD }, { path: 'locked.md' }]),
      'locked.md',
      (header) => header.writeUInt16LE(header.readUInt16LE(8) | 0x1, 8),
    );
    expect(problemsOf(await unpack(zip))[0]).toEqual({
      title: 'Encrypted file in the zip.',
      detail: 'locked.md is password-protected. Zip it without a password.',
    });
  });

  it('lists at most ten problems and sums up the rest', async () => {
    const links = Array.from({ length: 15 }, (_, i) => ({
      path: `link-${i}`,
      content: 'target',
      mode: 0o120777,
    }));
    const problems = problemsOf(
      await unpack(await buildZip([{ path: 'SKILL.md', content: SKILL_MD }, ...links])),
    );
    expect(problems).toHaveLength(10);
    expect(problems[9]).toEqual({
      title: '6 more problems.',
      detail: 'Fix the ones above and upload again.',
    });
  });
});

describe('unpackSkillZip: size limits', () => {
  it('refuses more entries than the limit before reading them', async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.md` }));
    const problems = problemsOf(
      await unpack(await buildZip(items), { ...SKILL_ZIP_LIMITS, maxEntries: 5 }),
    );
    expect(problems).toEqual([
      { title: 'Too many files.', detail: 'The zip lists 6 entries; the limit is 5.' },
    ]);
    // The real limit is 2,000 entries.
    expect(SKILL_ZIP_LIMITS.maxEntries).toBe(2000);
    expect(SKILL_ZIP_LIMITS.maxUnpackedBytes).toBe(100 * 1024 * 1024);
  });

  it('refuses an archive whose declared unpacked size passes the limit', async () => {
    const problems = problemsOf(
      await unpack(
        await buildZip([
          { path: 'SKILL.md', content: SKILL_MD },
          { path: 'a.bin', content: randomBytes(600) },
          { path: 'b.bin', content: randomBytes(600) },
        ]),
        { ...SKILL_ZIP_LIMITS, maxUnpackedBytes: 1000 },
      ),
    );
    expect(problems).toEqual([
      {
        title: 'Too large unpacked.',
        detail: `The files add up to ${formatBytes(Buffer.byteLength(SKILL_MD) + 1200)}; the limit is 1000 B.`,
      },
    ]);
    expect(await written()).toEqual([]);
  });

  it('refuses a compression bomb by its ratio', async () => {
    const problems = problemsOf(
      await unpack(
        await buildZip([
          { path: 'SKILL.md', content: SKILL_MD },
          { path: 'zeros.bin', content: Buffer.alloc(2 * 1024 * 1024) },
        ]),
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.title).toBe('Suspicious compression ratio.');
    expect(problems[0]?.detail).toMatch(
      /^zeros\.bin expands from .+ to 2 MB, more than 200 times\.$/,
    );
  });

  it('stops an entry that inflates past the size its header declares', async () => {
    const big = Buffer.alloc(300 * 1024, 'a');
    const zip = patchCentral(
      await buildZip([
        { path: 'SKILL.md', content: SKILL_MD },
        { path: 'liar.txt', content: big },
      ]),
      'liar.txt',
      (header) => header.writeUInt32LE(100, 24),
    );
    const problems = problemsOf(await unpack(zip));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.title).toBe('Corrupt zip.');
    expect(problems[0]?.detail).toMatch(/^liar\.txt could not be unpacked \(too many bytes/);
  });
});
