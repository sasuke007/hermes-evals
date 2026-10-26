/** stderr.log and its tail (plan 8.3): every line is counted, the last ones kept redacted. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redactor } from './redaction.js';
import { StderrCapture, storeStderrLog } from './stderr-capture.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stderr-capture-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('StderrCapture', () => {
  it('counts every line of stderr.log, across chunks and without a final newline', async () => {
    const capture = new StderrCapture(join(dir, 'stderr.log'));
    expect(capture.lines).toBe(0);
    capture.push(Buffer.from('one\ntw'));
    capture.push(Buffer.from('o\nthree'));
    expect(capture.lines).toBe(3);
    capture.push(Buffer.from('\n'));
    capture.push(Buffer.alloc(0));
    expect(capture.lines).toBe(3);
    for (let i = 0; i < 60; i += 1) capture.push(Buffer.from(`line ${i}\n`));
    expect(capture.lines).toBe(63);
    await capture.close();
    expect((await readFile(join(dir, 'stderr.log'), 'utf8')).split('\n')).toHaveLength(64);
    const tail = capture.tailLines(new Redactor({}))!.split('\n');
    expect(tail).toHaveLength(40);
    expect(tail.at(-1)).toBe('line 59');
  });
});

describe('the log end the API serves (Phase 7)', () => {
  const SECRET = 'sk-live-0123456789abcdef';
  const capture = async (chunks: string[]) => {
    const c = new StderrCapture(join(dir, 'stderr.log'));
    for (const chunk of chunks) c.push(Buffer.from(chunk));
    await c.close();
    return c;
  };

  it('is the whole log, redacted, when it fits', async () => {
    const c = await capture([`key ${SECRET}\n`, 'done\n']);
    const redactor = new Redactor({ API_KEY: SECRET });
    expect(await c.logEnd(redactor)).toEqual({
      text: 'key <from env API_KEY>\ndone\n',
      bytes: Buffer.byteLength(`key ${SECRET}\ndone\n`),
      replaced: 1,
    });
    // logEnd never counts; the caller decides.
    expect(redactor.count).toBe(0);
  });

  it('is the end from a line start when the log is longer, a value across the cut redacted', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, '0')}\n`);
    // 900 bytes, the value at 902 to 926, then 180: the last 200 bytes start inside the value.
    const c = await capture([...lines, `x ${SECRET}\n`, ...lines.slice(0, 20)]);
    const end = (await c.logEnd(new Redactor({ API_KEY: SECRET }), 200))!;
    expect(end.bytes).toBe(1107);
    expect(Buffer.byteLength(end.text)).toBeLessThanOrEqual(200);
    expect(end.text.startsWith('line 000\n')).toBe(true);
    expect(end.text.endsWith('line 019\n')).toBe(true);
    expect(end.text).not.toContain('abcdef');
  });

  it('redacts a value with a line break that the cut splits', async () => {
    // A multi-line value (a key file in an env value): its second line starts the kept end.
    const pem = 'BEGIN KEY\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nEND KEY';
    const c = await capture(['a'.repeat(300), '\n', pem, '\n', 'tail line\n']);
    const keep = Buffer.byteLength(`${pem.slice(pem.indexOf('\n') + 1)}\ntail line\n`);
    const end = (await c.logEnd(new Redactor({ KEY: pem }), keep))!;
    expect(end.text).not.toContain('MIIE');
    // Redacted whole before the cut, the shorter marker leaves room for the line it is on.
    expect(end.text).toBe('<from env KEY>\ntail line\n');
    expect(end.replaced).toBe(1);
  });

  it('keeps one long line from its cut when the end has no line start', async () => {
    const c = await capture(['y'.repeat(500)]);
    const end = (await c.logEnd(new Redactor({}), 100))!;
    expect(end).toEqual({ text: 'y'.repeat(100), bytes: 500, replaced: 0 });
  });

  it('is cut from a line start when the log is one byte over, the read starting at 0', async () => {
    // The read would start longestForm * 4 before the end: before the file, so at 0.
    const lines = Array.from({ length: 22 }, (_, i) => `line ${String(i).padStart(3, '0')}\n`);
    const c = await capture([...lines, 'ab\n']);
    const redactor = new Redactor({ API_KEY: SECRET });
    expect(redactor.longestForm).toBeGreaterThan(0);
    const end = (await c.logEnd(redactor, 200))!;
    expect(end.bytes).toBe(201);
    expect(Buffer.byteLength(end.text)).toBeLessThanOrEqual(200);
    expect(end.text.startsWith('line 001\n')).toBe(true);
    expect(end.text.endsWith('line 021\nab\n')).toBe(true);
  });

  it('is held to maxBytes when the redaction makes a log that fits longer', async () => {
    // Every '1' becomes a 16-character marker: 200 bytes on disk, 2,900 once redacted.
    const line = `${'1'.repeat(9)}\n`;
    const c = await capture(Array.from({ length: 20 }, () => line));
    expect(c.bytes).toBe(200);
    const end = (await c.logEnd(new Redactor({ DEBUG: '1' }), 200))!;
    expect(Buffer.byteLength(end.text)).toBeLessThanOrEqual(200);
    // The last 200 bytes start inside the line before: the end is the last line, whole.
    expect(end.text).toBe(`${'<from env DEBUG>'.repeat(9)}\n`);
    expect(end).toMatchObject({ bytes: 200, replaced: 9 });
  });

  it('starts a cut with no line start at a whole character', async () => {
    // 2-byte characters, the read starting inside one: no U+FFFD makes the text longer.
    const c = await capture(['é'.repeat(100)]);
    const end = (await c.logEnd(new Redactor({}), 99))!;
    expect(Buffer.byteLength(end.text)).toBeLessThanOrEqual(99);
    expect(end.text).toBe('é'.repeat(49));
  });

  it('is null for an empty log', async () => {
    expect(await (await capture([])).logEnd(new Redactor({}))).toBeNull();
  });

  it('is stored as a blob, counting only the replacements the tail did not', async () => {
    const c = await capture([`a ${SECRET}\n`, ...Array.from({ length: 50 }, (_, i) => `l${i}\n`)]);
    const redactor = new Redactor({ API_KEY: SECRET });
    // The tail (last 40 lines) holds no value, so it counted none.
    expect(c.tailLines(redactor)).not.toContain('from env');
    expect(redactor.count).toBe(0);
    const stored: Buffer[] = [];
    const blobs = {
      putBuffer: async (content: Uint8Array) => {
        stored.push(Buffer.from(content));
        return { sha256: 'f'.repeat(64), size: content.length };
      },
    };
    expect(await storeStderrLog(c, redactor, blobs, 0)).toEqual({
      sha256: 'f'.repeat(64),
      bytes: c.bytes,
    });
    expect(stored[0]!.toString('utf8').startsWith('a <from env API_KEY>\nl0\n')).toBe(true);
    expect(redactor.count).toBe(1);
    // With the tail having counted the same value already, nothing is added.
    await storeStderrLog(c, redactor, blobs, 1);
    expect(redactor.count).toBe(1);
  });
});
