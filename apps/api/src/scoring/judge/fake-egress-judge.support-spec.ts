/**
 * A stand-in for egress's judge path on a real unix socket, for tests of the
 * judge client and scorer with the real EgressClient: it holds judge
 * registrations, meters usage per registration and answers removal with the
 * report, as apps/egress/src/judge-path.ts does. Each chat completion is
 * answered by the test's `respond`, which plays the provider: an upstream
 * answer (relayed in egress's 200 envelope), egress's own refusal, or no
 * answer at all. No model and no network are involved.
 */
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EgressJudgeChatBody, EgressUsage } from '../../sandbox/egress-client.js';

/** How the fake answers one call. */
export type FakeAnswer =
  /** An upstream answered: relayed as egress's envelope, with this usage. */
  | { upstream: number; body: unknown; usage?: EgressUsage | null }
  /** Egress itself answered with this status (a refusal). */
  | { egress: number; body: unknown }
  /** Nobody answers. */
  | 'hang';

export interface FakeEgressJudge {
  socket: string;
  /** Every registration egress received, by judge id, in order. */
  registrations: Array<{ judgeId: string; body: Record<string, unknown> }>;
  /** Every chat body forwarded, in order. */
  calls: Array<{ judgeId: string; body: EgressJudgeChatBody }>;
  /** Judge ids removed. */
  removed: string[];
  /** Plays the provider; `n` counts calls from 0 across the fake's life. */
  respond: (body: EgressJudgeChatBody, n: number) => FakeAnswer;
  /** When set, PUT /judges answers this status and message instead of 204. */
  refuseRegistration: { status: number; message: string } | null;
  close(): Promise<void>;
}

/** An OpenAI chat completion whose first choice says `content`. */
export const chatCompletion = (
  content: string | null,
  extra: { model?: string; finish_reason?: string; refusal?: string } = {},
) => ({
  id: 'chatcmpl-fake',
  object: 'chat.completion',
  model: extra.model ?? 'judge/model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content, ...(extra.refusal ? { refusal: extra.refusal } : {}) },
      finish_reason: extra.finish_reason ?? 'stop',
    },
  ],
});

export const usageOf = (prompt: number, completion: number): EgressUsage => ({
  calls: 1,
  promptTokens: prompt,
  completionTokens: completion,
  totalTokens: prompt + completion,
});

export async function startFakeEgressJudge(): Promise<FakeEgressJudge> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-egress-judge-'));
  const socket = join(dir, 'admin.sock');
  const metered = new Map<string, EgressUsage>();
  let n = 0;
  const fake: FakeEgressJudge = {
    socket,
    registrations: [],
    calls: [],
    removed: [],
    respond: () => ({ upstream: 200, body: chatCompletion('{"score":1,"comment":"ok"}') }),
    refuseRegistration: null,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
  const send = (res: http.ServerResponse, status: number, body?: unknown) =>
    body === undefined
      ? res.writeHead(status).end()
      : res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      const match = /^\/judges\/([0-9A-Z]{26})(\/chat\/completions)?$/.exec(req.url ?? '');
      if (!match) return send(res, 404, { message: 'not found' });
      const judgeId = match[1]!;
      if (req.method === 'PUT') {
        if (fake.refuseRegistration) {
          return send(res, fake.refuseRegistration.status, {
            message: fake.refuseRegistration.message,
          });
        }
        fake.registrations.push({ judgeId, body: JSON.parse(text) });
        metered.set(judgeId, { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        return send(res, 204);
      }
      if (req.method === 'DELETE') {
        const usage = metered.get(judgeId);
        if (!usage) return send(res, 404, { error: { message: 'unknown judge registration' } });
        metered.delete(judgeId);
        fake.removed.push(judgeId);
        return send(res, 200, { usage, log: [] });
      }
      const usage = metered.get(judgeId);
      if (!usage) return send(res, 404, { error: { message: 'unknown judge registration' } });
      const body = JSON.parse(text) as EgressJudgeChatBody;
      fake.calls.push({ judgeId, body });
      const answer = fake.respond(body, n++);
      if (answer === 'hang') return;
      if ('egress' in answer) return send(res, answer.egress, answer.body);
      const used = answer.usage === undefined ? usageOf(40, 10) : answer.usage;
      usage.calls += 1;
      if (used) {
        usage.promptTokens += used.promptTokens;
        usage.completionTokens += used.completionTokens;
        usage.totalTokens += used.totalTokens;
      }
      return send(res, 200, { status: answer.upstream, body: answer.body, usage: used });
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return fake;
}
