/**
 * A scripted OpenAI-compatible model for tests, the isolation self-test and
 * the Live stage. It never thinks: the n-th call (n = tool results already in
 * the conversation) plays the n-th step of its script, either a tool call or
 * a final answer, and the last step repeats once the script runs out. It
 * speaks both streaming and non-streaming chat completions and records every
 * request it receives (GET /__requests) so a test can see exactly what
 * Hermes sent, and which script answered.
 *
 *   MOCK_PORT     default 8090
 *   MOCK_MODEL    model id it serves (default mock/scripted)
 *   MOCK_STEPS    JSON array of { "tool": name, "arguments": {...} } | { "content": "..." }
 *   MOCK_SCRIPTS  optional JSON array of { "match": "...", "steps": [...] }. The
 *                 first script whose `match` occurs anywhere in the request's
 *                 messages (system prompt, skills and tool results included)
 *                 plays its steps; with none matching, MOCK_STEPS plays. This
 *                 is how two configurations get different answers from one
 *                 mock: match a phrase only one arm's skill or document holds.
 *                 Match on text present from the first call, or the script can
 *                 change mid-run when a tool result first contains the phrase.
 *
 * Run as a script (`node dist/mock-model.js`) it listens; imported, it only
 * exports the pieces, so the unit test starts its own server.
 */
import { realpathSync } from 'node:fs';
import http, { type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseTarget } from './handler.js';

const StepSchema = z.union([
  z.object({ tool: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }),
  z.object({ content: z.string() }),
]);
const StepsSchema = z.array(StepSchema).min(1);
const ScriptsSchema = z.array(z.object({ match: z.string().min(1), steps: StepsSchema }));

export type MockStep = z.infer<typeof StepSchema>;
export type MockScript = z.infer<typeof ScriptsSchema>[number];

export interface MockModelOptions {
  /** The model id /models lists and responses carry when the request names none. */
  model: string;
  /** Played when no script matches (MOCK_STEPS). */
  steps: MockStep[];
  /** Tried in order (MOCK_SCRIPTS); empty when unset. */
  scripts: MockScript[];
}

const DEFAULT_STEPS = '[{"content":"Done."}]';

/** Reads one JSON variable against its schema; a bad value stops the mock with its name. */
function parseVariable<T>(name: string, raw: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${name} is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The mock's settings from its environment. Throws, naming the variable, on a bad value. */
export function mockModelOptions(env: NodeJS.ProcessEnv): MockModelOptions {
  return {
    model: env.MOCK_MODEL ?? 'mock/scripted',
    steps: parseVariable('MOCK_STEPS', env.MOCK_STEPS ?? DEFAULT_STEPS, StepsSchema),
    scripts: env.MOCK_SCRIPTS ? parseVariable('MOCK_SCRIPTS', env.MOCK_SCRIPTS, ScriptsSchema) : [],
  };
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
}

interface ChatRequest {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Every text a script can match: each message's content, as a string or as
 * the text parts of a content array, and the arguments of assistant tool
 * calls. Plain text, not JSON, so a phrase with quotes or newlines matches as
 * it was written.
 */
export function messageText(messages: readonly unknown[]): string {
  const texts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const { content, tool_calls: calls } = message;
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (isRecord(part) && typeof part.text === 'string') texts.push(part.text);
      }
    }
    if (Array.isArray(calls)) {
      for (const call of calls) {
        const fn = isRecord(call) ? call.function : undefined;
        if (isRecord(fn) && typeof fn.arguments === 'string') texts.push(fn.arguments);
      }
    }
  }
  return texts.join('\n');
}

/** The script that answers a request: the first match, else the default steps (`match` null). */
export function chooseScript(
  options: Pick<MockModelOptions, 'steps' | 'scripts'>,
  messages: readonly unknown[],
): { match: string | null; steps: MockStep[] } {
  if (options.scripts.length > 0) {
    const text = messageText(messages);
    const script = options.scripts.find((s) => text.includes(s.match));
    if (script) return { match: script.match, steps: script.steps };
  }
  return { match: null, steps: options.steps };
}

function usageFor(request: unknown, completion: string) {
  const prompt = Math.ceil(JSON.stringify(request).length / 4);
  const completionTokens = Math.ceil(completion.length / 4) + 1;
  return {
    prompt_tokens: prompt,
    completion_tokens: completionTokens,
    total_tokens: prompt + completionTokens,
  };
}

function reply(
  res: ServerResponse,
  request: ChatRequest,
  steps: readonly MockStep[],
  model: string,
  id: string,
): void {
  const toolResults = (request.messages ?? []).filter((m) => m.role === 'tool').length;
  const step = steps[Math.min(toolResults, steps.length - 1)]!;
  const created = Math.floor(Date.now() / 1000);
  const toolCall =
    'tool' in step
      ? {
          id: `call_${toolResults}`,
          type: 'function',
          function: { name: step.tool, arguments: JSON.stringify(step.arguments) },
        }
      : null;
  const content = 'content' in step ? step.content : null;
  const usage = usageFor(request, content ?? JSON.stringify(toolCall));
  const finish = toolCall ? 'tool_calls' : 'stop';

  if (!request.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model: request.model ?? model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content,
              ...(toolCall ? { tool_calls: [toolCall] } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage,
      }),
    );
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: request.model ?? model, choices, ...extra })}\n\n`,
    );
  send([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
  if (toolCall) {
    send([{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }]);
  } else {
    for (const piece of (content ?? '').match(/[\s\S]{1,40}/g) ?? ['']) {
      send([{ index: 0, delta: { content: piece }, finish_reason: null }]);
    }
  }
  send([{ index: 0, delta: {}, finish_reason: finish }]);
  send([], { usage });
  res.end('data: [DONE]\n\n');
}

/** The mock's HTTP server, not yet listening. Each server keeps its own request log. */
export function createMockModelServer(options: MockModelOptions): Server {
  const received: unknown[] = [];
  return http.createServer(async (req, res) => {
    const url = parseTarget(req.url, 'http://mock');
    if (!url) {
      res.writeHead(400).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__requests') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(received));
      return;
    }
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: options.model,
              object: 'model',
              owned_by: 'hermes-evals',
              context_length: 131072,
            },
          ],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      let request: ChatRequest;
      try {
        const parsed: unknown = JSON.parse(body);
        if (!isRecord(parsed)) throw new Error('not an object');
        request = parsed as ChatRequest;
      } catch {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end('{"error":{"message":"request body is not a JSON object"}}');
        return;
      }
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const script = chooseScript(options, messages);
      const id = `chatcmpl-mock-${received.length}`;
      received.push({
        path: url.pathname,
        headers: { authorization: req.headers.authorization ?? null },
        script: script.match,
        body: request,
      });
      reply(res, { ...request, messages }, script.steps, options.model, id);
      return;
    }
    res
      .writeHead(404, { 'content-type': 'application/json' })
      .end('{"error":{"message":"not found"}}');
  });
}

/** True when this file is the process's entry point rather than an import. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const port = Number(process.env.MOCK_PORT ?? 8090);
  const server = createMockModelServer(mockModelOptions(process.env));
  server.listen(port, '0.0.0.0', () => process.stdout.write(`mock model listening on ${port}\n`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
