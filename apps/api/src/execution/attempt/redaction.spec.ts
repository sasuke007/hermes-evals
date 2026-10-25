import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redactor } from './redaction.js';
import { StderrCapture } from './stderr-capture.js';

describe('Redactor', () => {
  it('replaces values in texts and every string of a payload, keys included, and counts them', () => {
    const r = new Redactor({ DB_KEY: 'sk-123456', EMPTY: '', TOKEN: 'tok-abcdef' });
    expect(r.text('key sk-123456 and tok-abcdef, again sk-123456')).toBe(
      'key <from env DB_KEY> and <from env TOKEN>, again <from env DB_KEY>',
    );
    expect(r.count).toBe(3);
    const payload = {
      type: 'tool_result',
      output: 'x sk-123456',
      nested: [{ 'sk-123456': 'tok-abcdef' }, 7, null],
    };
    expect(r.json(payload)).toEqual({
      type: 'tool_result',
      output: 'x <from env DB_KEY>',
      nested: [{ '<from env DB_KEY>': '<from env TOKEN>' }, 7, null],
    });
    expect(r.count).toBe(6);
  });

  it('returns a payload without values untouched, and never matches an empty value', () => {
    const r = new Redactor({ EMPTY: '' });
    const payload = { type: 'text', text: '' };
    expect(r.json(payload)).toBe(payload);
    expect(r.text('anything')).toBe('anything');
    expect(r.count).toBe(0);
  });

  it('catches a value in its JSON-escaped form', () => {
    const r = new Redactor({ PEM: 'line1\nline2"q' });
    expect(r.text('{"v":"line1\\nline2\\"q"}')).toBe('{"v":"<from env PEM>"}');
    expect(r.count).toBe(1);
  });
});

describe('StderrCapture', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stderr-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps every byte in stderr.log and the last 40 lines, redacted before they are cut', async () => {
    const path = join(dir, 'stderr.log');
    const capture = new StderrCapture(path);
    const r = new Redactor({ KEY: 'secret-value-1' });
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    lines[59] = 'final secret-value-1 here';
    // A value split across chunks is still caught: chunks are joined before redaction.
    const text = `${lines.join('\n')}\n`;
    const at = text.indexOf('secret-value-1') + 5;
    capture.push(Buffer.from(text.slice(0, at)));
    capture.push(Buffer.from(text.slice(at)));
    await capture.close();
    expect(await readFile(path, 'utf8')).toBe(text);
    const tail = capture.tailLines(r)!;
    expect(tail.split('\n')).toHaveLength(40);
    expect(tail.split('\n')[0]).toBe('line 20');
    expect(tail.endsWith('final <from env KEY> here')).toBe(true);
    expect(r.count).toBe(1);
  });

  it('is null when the trial wrote nothing, and refuses an existing file', async () => {
    const capture = new StderrCapture(join(dir, 'stderr.log'));
    await capture.close();
    expect(capture.tailLines(new Redactor({}))).toBeNull();
    // The second capture on the same path cannot open it, but still keeps its tail.
    const again = new StderrCapture(join(dir, 'stderr.log'));
    again.push(Buffer.from('kept\n'));
    await again.close();
    expect(again.tailLines(new Redactor({}))).toBe('kept');
  });

  it('drops the partial first line once more than the held bytes were written', async () => {
    const capture = new StderrCapture(join(dir, 'stderr.log'));
    capture.push(Buffer.from(`${'a'.repeat(70 * 1024)}\nlast line\n`));
    await capture.close();
    expect(capture.tailLines(new Redactor({}))).toBe('last line');
  });
});
