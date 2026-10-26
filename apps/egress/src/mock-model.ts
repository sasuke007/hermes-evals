/**
 * A scripted OpenAI-compatible model for tests, the isolation self-test and
 * the Live stage. It never thinks: the n-th call (n = tool results already in
 * the conversation) plays the n-th step of its script, either a tool call or
 * a final answer, and the last step repeats once the script runs out. It
 * speaks both streaming and non-streaming chat completions and records every
 * request it receives (GET /__requests) so a test can see exactly what
 * Hermes sent, and which script answered.
 *
 *   MOCK_PORT          default 8090
 *   MOCK_MODEL         model id it serves (default mock/scripted)
 *   MOCK_STEPS         JSON array of { "tool": name, "arguments": {...} } | { "content": "..." }
 *   MOCK_SCRIPTS       optional JSON array of { "match": "...", "steps": [...] },
 *                      for short overrides
 *   MOCK_SCRIPTS_FILE  optional file holding such an array, or a directory of
 *                      `*.json` files that each hold one (mock-scripts.ts);
 *                      Compose mounts the file or directory you name
 *
 * The first script, MOCK_SCRIPTS's then the file's, whose `match` occurs
 * anywhere in the request's messages (system prompt, skills and tool results
 * included) plays its steps; with none matching, MOCK_STEPS plays. This is
 * how two configurations get different answers from one mock: match a phrase
 * only one arm's skill or document holds. Match on text present from the
 * first call, or the script can change mid-run when a tool result first
 * contains the phrase.
 *
 * Run as a script (`node dist/mock-model.js`) it listens; with
 * `--print-scripts` it prints the scripts it would play, as one JSON array,
 * and exits (what the smoke tests check). Imported, it only exports the
 * pieces, so the unit test starts its own server.
 */
import { realpathSync } from 'node:fs';
import http, { type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseTarget } from './handler.js';
import {
  parseJson,
  readScriptsFile,
  ScriptsSchema,
  StepsSchema,
  type MockScript,
  type MockStep,
} from './mock-scripts.js';

export type { MockScript, MockStep } from './mock-scripts.js';

export interface MockModelOptions {
  /** The model id /models lists and responses carry when the request names none. */
  model: string;
  /** Played when no script matches (MOCK_STEPS). */
  steps: MockStep[];
  /** Tried in order: MOCK_SCRIPTS's, then MOCK_SCRIPTS_FILE's; empty when neither is set. */
  scripts: MockScript[];
  /** Where the scripts came from, for the start log; absent when options are built by hand. */
  loaded?: { variable: number; file: { path: string; files: number; scripts: number } | null };
}

const DEFAULT_STEPS = '[{"content":"Done."}]';

/** The mock's settings from its environment. Throws, naming the variable or file, on a bad value. */
export function mockModelOptions(env: NodeJS.ProcessEnv): MockModelOptions {
  const overrides = env.MOCK_SCRIPTS
    ? parseJson('MOCK_SCRIPTS', env.MOCK_SCRIPTS, ScriptsSchema)
    : [];
  const file = env.MOCK_SCRIPTS_FILE ? readScriptsFile(env.MOCK_SCRIPTS_FILE) : null;
  return {
    model: env.MOCK_MODEL ?? 'mock/scripted',
    steps: parseJson('MOCK_STEPS', env.MOCK_STEPS ?? DEFAULT_STEPS, StepsSchema),
    scripts: [...overrides, ...(file?.scripts ?? [])],
    loaded: {
      variable: overrides.length,
      file: file
        ? { path: file.path, files: file.files.length, scripts: file.scripts.length }
        : null,
    },
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

/** The start line: the port and where the scripts came from. */
export function startMessage(port: number, options: MockModelOptions): string {
  const loaded = options.loaded;
  const from = loaded
    ? [
        `${loaded.variable} from MOCK_SCRIPTS`,
        ...(loaded.file
          ? [
              `${loaded.file.scripts} from ${loaded.file.files} file${loaded.file.files === 1 ? '' : 's'} at ${loaded.file.path}`,
            ]
          : []),
      ].join(', ')
    : 'given by the caller';
  return `mock model listening on ${port} · ${options.scripts.length} scripts (${from})`;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `--print-scripts`: the scripts the mock would play, MOCK_SCRIPTS's then
 * MOCK_SCRIPTS_FILE's, as one JSON array on one line (exit 0), or why they
 * cannot be read (exit 1).
 */
export function printScripts(env: NodeJS.ProcessEnv): {
  code: 0 | 1;
  stdout: string;
  stderr: string;
} {
  try {
    return { code: 0, stdout: `${JSON.stringify(mockModelOptions(env).scripts)}\n`, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `mock model: ${messageOf(err)}\n` };
  }
}

if (isEntryPoint()) {
  if (process.argv.includes('--print-scripts')) {
    const printed = printScripts(process.env);
    process.stdout.write(printed.stdout);
    process.stderr.write(printed.stderr);
    process.exit(printed.code);
  }
  let options: MockModelOptions;
  try {
    options = mockModelOptions(process.env);
  } catch (err) {
    process.stderr.write(`mock model: ${messageOf(err)}\n`);
    process.exit(1);
  }
  const port = Number(process.env.MOCK_PORT ?? 8090);
  const server = createMockModelServer(options);
  server.listen(port, '0.0.0.0', () => process.stdout.write(`${startMessage(port, options)}\n`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
