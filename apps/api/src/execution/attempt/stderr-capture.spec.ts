/** stderr.log and its tail (plan 8.3): every line is counted, the last ones kept redacted. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redactor } from './redaction.js';
import { StderrCapture } from './stderr-capture.js';

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
