/**
 * A scripted OpenAI-compatible model for tests and the isolation self-test.
 * It never thinks: the n-th call (n = tool results already in the
 * conversation) plays the n-th step of MOCK_STEPS, either a tool call or a
 * final answer. It speaks both streaming and non-streaming chat completions
 * and records every request it receives (GET /__requests) so a test can see
 * exactly what Hermes sent.
 *
 *   MOCK_PORT   default 8090
 *   MOCK_MODEL  model id it serves (default mock/scripted)
 *   MOCK_STEPS  JSON array of { "tool": name, "arguments": {...} } | { "content": "..." }
 */
import http, { type ServerResponse } from 'node:http';
import { parseTarget } from './handler.js';

type Step = { tool: string; arguments: Record<string, unknown> } | { content: string };

const port = Number(process.env.MOCK_PORT ?? 8090);
const model = process.env.MOCK_MODEL ?? 'mock/scripted';
const steps: Step[] = JSON.parse(process.env.MOCK_STEPS ?? '[{"content":"Done."}]') as Step[];
const received: unknown[] = [];

interface ChatRequest {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role: string }>;
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

function reply(res: ServerResponse, request: ChatRequest): void {
  const toolResults = (request.messages ?? []).filter((m) => m.role === 'tool').length;
  const step = steps[Math.min(toolResults, steps.length - 1)]!;
  const id = `chatcmpl-mock-${received.length}`;
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

const server = http.createServer(async (req, res) => {
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
        data: [{ id: model, object: 'model', owned_by: 'hermes-evals', context_length: 131072 }],
      }),
    );
    return;
  }
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as ChatRequest;
    received.push({
      path: url.pathname,
      headers: { authorization: req.headers.authorization ?? null },
      body: request,
    });
    reply(res, request);
    return;
  }
  res
    .writeHead(404, { 'content-type': 'application/json' })
    .end('{"error":{"message":"not found"}}');
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`mock model listening on ${port}\n`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
