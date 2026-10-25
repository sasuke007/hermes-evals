import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chooseScript,
  createMockModelServer,
  messageText,
  mockModelOptions,
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
  it('keeps the single-script behaviour when MOCK_SCRIPTS is unset', () => {
    expect(mockModelOptions({})).toEqual({
      model: 'mock/scripted',
      steps: [{ content: 'Done.' }],
      scripts: [],
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
