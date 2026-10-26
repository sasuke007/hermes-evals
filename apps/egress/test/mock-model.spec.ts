import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chooseScript,
  createMockModelServer,
  messageText,
  mockModelOptions,
  printScripts,
  startMessage,
  type MockModelOptions,
} from '../src/mock-model.js';

const SKILL_PHRASE = 'Always reconcile against the ledger.';
const options: MockModelOptions = mockModelOptions({
  MOCK_STEPS: JSON.stringify([
    { tool: 'terminal', arguments: { command: 'ls' } },
    { content: 'Default answer.' },
  ]),
  MOCK_SCRIPTS: JSON.stringify([
    { match: SKILL_PHRASE, steps: [{ content: 'Skill answer: "1042.00"' }] },
    { match: 'second', steps: [{ content: 'second script' }] },
  ]),
});

const server = createMockModelServer(options);
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Completion {
  choices: Array<{
    message: { content: string | null; tool_calls?: Array<{ function: { name: string } }> };
    finish_reason: string;
  }>;
}

const chat = async (messages: unknown[], stream = false): Promise<Response> =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify({ model: 'mock/scripted', stream, messages }),
  });

const answer = async (messages: unknown[]): Promise<Completion['choices'][number]> =>
  ((await (await chat(messages)).json()) as Completion).choices[0]!;

describe('mockModelOptions', () => {
  it('keeps the single-script behaviour when MOCK_SCRIPTS and MOCK_SCRIPTS_FILE are unset', () => {
    const empty = { model: 'mock/scripted', steps: [{ content: 'Done.' }], scripts: [] };
    const loaded = { variable: 0, file: null };
    expect(mockModelOptions({})).toEqual({ ...empty, loaded });
    // Compose passes an unset variable as empty.
    expect(mockModelOptions({ MOCK_SCRIPTS: '', MOCK_SCRIPTS_FILE: '' })).toEqual({
      ...empty,
      loaded,
    });
  });

  it('refuses a bad variable by name', () => {
    expect(() => mockModelOptions({ MOCK_SCRIPTS: '{' })).toThrow('MOCK_SCRIPTS is not valid JSON');
    expect(() => mockModelOptions({ MOCK_SCRIPTS: '[{"match":"","steps":[]}]' })).toThrow(
      /MOCK_SCRIPTS is invalid/,
    );
    expect(() => mockModelOptions({ MOCK_STEPS: '[]' })).toThrow(/MOCK_STEPS is invalid/);
  });
});

describe('MOCK_SCRIPTS_FILE (Phase 7)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-scripts-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = (match: string) => ({ match, steps: [{ content: match }] });
  const write = (path: string, value: unknown) => {
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };

  it('reads a file of scripts, after the MOCK_SCRIPTS overrides', () => {
    const file = write(join(dir, 'one.json'), [script('from-file'), script('shared')]);
    const options = mockModelOptions({
      MOCK_SCRIPTS: JSON.stringify([script('shared')]),
      MOCK_SCRIPTS_FILE: file,
    });
    expect(options.scripts.map((s) => s.match)).toEqual(['shared', 'from-file', 'shared']);
    expect(options.loaded).toEqual({ variable: 1, file: { path: file, files: 1, scripts: 2 } });
    // The override wins: the first script whose phrase a request holds plays.
    expect(chooseScript(options, [{ role: 'user', content: 'shared' }]).steps).toBe(
      options.scripts[0]!.steps,
    );
    expect(startMessage(8090, options)).toBe(
      `mock model listening on 8090 · 3 scripts (1 from MOCK_SCRIPTS, 2 from 1 file at ${file})`,
    );
  });

  it('reads every .json file of a directory in name order, and nothing else', () => {
    const scripts = join(dir, 'scripts');
    mkdirSync(join(scripts, 'fixtures'), { recursive: true });
    write(join(scripts, 'phase3-mock-scripts.json'), [script('three')]);
    write(join(scripts, 'phase2-mock-scripts.json'), [script('two-a'), script('two-b')]);
    write(join(scripts, 'phase2-smoke.sh'), 'echo not json');
    write(join(scripts, 'fixtures', 'nested.json'), [script('nested')]);
    const options = mockModelOptions({ MOCK_SCRIPTS_FILE: scripts });
    expect(options.scripts.map((s) => s.match)).toEqual(['two-a', 'two-b', 'three']);
    expect(options.loaded?.file).toEqual({ path: scripts, files: 2, scripts: 3 });
  });

  it('gives no scripts for an empty directory, and says so at start', () => {
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    const options = mockModelOptions({ MOCK_SCRIPTS_FILE: empty });
    expect(options.scripts).toEqual([]);
    expect(startMessage(8090, options)).toContain('0 from 0 files at');
  });

  it('refuses a missing path or a bad file by name', () => {
    expect(() => mockModelOptions({ MOCK_SCRIPTS_FILE: join(dir, 'nope.json') })).toThrow(
      /^MOCK_SCRIPTS_FILE .*nope\.json cannot be read \(ENOENT\)$/,
    );
    const broken = write(join(dir, 'broken.json'), '[{');
    expect(() => mockModelOptions({ MOCK_SCRIPTS_FILE: broken })).toThrow(
      `MOCK_SCRIPTS_FILE ${broken} is not valid JSON`,
    );
    const invalid = write(join(dir, 'invalid.json'), [{ match: '', steps: [] }]);
    expect(() => mockModelOptions({ MOCK_SCRIPTS_FILE: invalid })).toThrow(
      `MOCK_SCRIPTS_FILE ${invalid} is invalid`,
    );
  });

  it('prints the scripts it would play for --print-scripts, or why it cannot', () => {
    const file = write(join(dir, 'print.json'), [script('printed')]);
    const printed = printScripts({
      MOCK_SCRIPTS: JSON.stringify([script('first')]),
      MOCK_SCRIPTS_FILE: file,
    });
    expect(printed.code).toBe(0);
    expect(JSON.parse(printed.stdout)).toEqual([script('first'), script('printed')]);
    expect(printScripts({ MOCK_SCRIPTS_FILE: join(dir, 'missing') })).toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringMatching(/^mock model: MOCK_SCRIPTS_FILE .* cannot be read/),
    });
  });
});

describe('chooseScript', () => {
  it('plays the first script whose phrase is in any message, else MOCK_STEPS', () => {
    const system = { role: 'system', content: `You are Hermes.\n${SKILL_PHRASE}` };
    expect(chooseScript(options, [system, { role: 'user', content: 'second' }]).match).toBe(
      SKILL_PHRASE,
    );
    expect(chooseScript(options, [{ role: 'user', content: 'the second one' }]).match).toBe(
      'second',
    );
    expect(chooseScript(options, [{ role: 'user', content: 'nothing here' }])).toEqual({
      match: null,
      steps: options.steps,
    });
  });

  it('reads content arrays and tool-call arguments as plain text', () => {
    const text = messageText([
      { role: 'user', content: [{ type: 'text', text: 'say "hi"\nplease' }, { type: 'image' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ function: { name: 'terminal', arguments: '{"command":"cat skill.md"}' } }],
      },
      'not a message',
    ]);
    expect(text).toBe('say "hi"\nplease\n{"command":"cat skill.md"}');
    expect(chooseScript({ steps: options.steps, scripts: [] }, [])).toEqual({
      match: null,
      steps: options.steps,
    });
  });
});

describe('the server', () => {
  it('gives a matching conversation its script and the others the default steps', async () => {
    const skilled = await answer([
      { role: 'system', content: `Skills:\n${SKILL_PHRASE}` },
      { role: 'user', content: 'Total the invoices.' },
    ]);
    expect(skilled.message.content).toBe('Skill answer: "1042.00"');
    expect(skilled.finish_reason).toBe('stop');

    const plain = await answer([{ role: 'user', content: 'Total the invoices.' }]);
    expect(plain.message.tool_calls?.[0]?.function.name).toBe('terminal');
    const second = await answer([
      { role: 'user', content: 'Total the invoices.' },
      { role: 'tool', content: 'invoices.csv' },
    ]);
    expect(second.message.content).toBe('Default answer.');

    const log = (await (await fetch(`${base}/__requests`)).json()) as Array<{
      script: string | null;
      headers: { authorization: string | null };
    }>;
    expect(log.map((r) => r.script)).toEqual([SKILL_PHRASE, null, null]);
    expect(log[0]?.headers.authorization).toBe('Bearer test-token');
  });

  it('streams the matched script', async () => {
    const res = await chat(
      [{ role: 'user', content: [{ type: 'text', text: 'the second' }] }],
      true,
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const body = await res.text();
    const pieces = body
      .split('\n\n')
      .filter((line) => line.startsWith('data: {'))
      .map(
        (line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string } }> },
      )
      .flatMap((chunk) => chunk.choices.map((c) => c.delta.content ?? ''));
    expect(pieces.join('')).toBe('second script');
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('answers a body that is not a JSON object with 400 instead of failing', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: 'nope' });
    expect(res.status).toBe(400);
  });
});
