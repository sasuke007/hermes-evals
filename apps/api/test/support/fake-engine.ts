/**
 * In-process stand-ins for the Docker Engine behind docker-guard and for
 * egress's admin socket, so the attempt runner, the execute-run handler and
 * the whole application can run in tests with no Docker and no egress.
 *
 * FakeEngine plays scripted "containers": each create asks the `script`
 * option what the container does once started (stdout lines, stderr, files
 * written to its workspace or home, an exit code, a hang until stopped, an
 * OOM kill). It behaves like the Engine where the trial runner relies on it:
 * - create refuses a duplicate name (409) and, when `guard` is given, any
 *   body docker-guard would refuse, with the guard's own reasons;
 * - `waitForExit` registers before start, so an instant exit is never missed;
 * - `logs` is a multiplexed stdout/stderr stream (8-byte frame headers) that
 *   replays what was already written and follows until the container exits;
 * - `stop` sends "SIGTERM" (exit 143 unless the script ignores it), then
 *   "SIGKILL" (exit 137) after the grace; `kill` exits 137 at once;
 * - `inspect` reports State.OOMKilled; `list` filters by label like the
 *   Engine (`key=value` or `key`), so clearRun, freeSlot and recovery work.
 *
 * FakeEgress records every registration (the trial's network policy, model
 * route and MCP routes), answers `remove` with a scripted usage and
 * connection log, and answers the names and health checks the worker's
 * provider guard asks it live. With a `judge` model it also serves the LLM
 * judge's path (registerJudge, judgeComplete, removeJudge) as egress's
 * /judges routes do: one model per registration, every call metered and
 * logged, the report handed back on removal. Without one, the judge path
 * refuses as an egress without /judges does (404).
 *
 * The integration e2e drives real worker handlers with these:
 *
 *   const engine = new FakeEngine({ trialsDir, guard, script: () => hermesRun('```json\n{"total": 1042}\n```') });
 *   const egress = new FakeEgress();
 *
 * Both extend the real clients (whose private members make them nominal
 * types), so they go wherever an EngineClient or EgressClient is expected.
 */
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { checkCreateBody, type GuardConfig } from '@hermes-evals/docker-guard/policy';
import {
  EgressCallError,
  EgressClient,
  type EgressHealth,
  type EgressJudgeChatBody,
  type EgressJudgeRegistration,
  type EgressJudgeReply,
  type EgressJudgeReport,
  type EgressLogEntry,
  type EgressRegistration,
  type EgressUsage,
} from '../../src/sandbox/egress-client.js';
import {
  EngineClient,
  EngineError,
  type ContainerState,
  type ContainerSummary,
} from '../../src/sandbox/engine-client.js';

/** A file a fake trial writes into one of its two mounts, creating parent directories. */
export interface FakeTrialFile {
  in: 'workspace' | 'home';
  /** Relative to the mount. */
  path: string;
  content: string | Buffer;
}

/** One thing a fake trial does, in order, after start. */
export type FakeStep =
  /** One stdout line; the newline is added. */
  | { stdout: string }
  /** Bytes on stdout exactly as given (no newline), e.g. half a line. */
  | { stdoutRaw: string }
  /** Bytes on stderr exactly as given. */
  | { stderr: string }
  | { file: FakeTrialFile }
  /** A symbolic link the agent made, e.g. to a path outside the trial. */
  | { symlink: { in: 'workspace' | 'home'; path: string; target: string } }
  | { sleep: number }
  /** Waits until the promise settles (a gate the test opens), or the container is stopped. */
  | { wait: Promise<unknown> };

export interface FakeTrialScript {
  steps?: FakeStep[];
  /** Exit code once the steps are done. Default 0. */
  exitCode?: number;
  /** After the steps, keep running until stopped or killed. */
  hang?: boolean;
  /** After the steps, die as the kernel's OOM killer would: exit 137 and State.OOMKilled. */
  oomKilled?: boolean;
  /** Ignore SIGTERM: a stop only ends the container when the grace runs out (exit 137). */
  ignoreSigterm?: boolean;
  /** Make create fail with this message (Engine status 500). */
  createError?: string;
  /** Make start fail with this message (Engine status 500). */
  startError?: string;
}

/** What a script function is told about the container being created. */
export interface FakeContainerInfo {
  id: string;
  name: string;
  body: Record<string, unknown>;
  labels: Record<string, string>;
  /** Container environment, parsed from Env. */
  env: Record<string, string>;
  /** Entrypoint and Cmd joined. */
  argv: string[];
  network: string;
  /** Worker-side paths of the mounts, when FakeEngine has a `trialsDir`. */
  homeDir: string | null;
  workspaceDir: string | null;
}

export interface FakeEngineOptions {
  /** Decides what each created container does. Default: exits 0 with no output. */
  script?: (container: FakeContainerInfo) => FakeTrialScript;
  /** Where the trial volume's subpaths live on this machine (the worker's TRIALS_DIR). */
  trialsDir?: string;
  /** Refuse create bodies docker-guard would refuse. */
  guard?: GuardConfig;
  /** Reported by info(): the daemon id recovery compares. */
  daemonId?: string;
}

interface FakeContainer {
  info: FakeContainerInfo;
  script: FakeTrialScript;
  state: 'created' | 'running' | 'exited';
  exitCode: number;
  oomKilled: boolean;
  startedAt: string;
  finishedAt: string;
  removed: boolean;
  frames: Buffer[];
  followers: Set<IncomingMessage>;
  exitWaiters: Array<(code: number) => void>;
  /** Wakes a hanging or sleeping script when the container is stopped. */
  interrupt: () => void;
}

const ZERO_TIME = '0001-01-01T00:00:00Z';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const frame = (stream: 1 | 2, payload: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

export class FakeEngine extends EngineClient {
  /** Every container ever created, in order, removed ones included. */
  readonly containers: FakeContainer[] = [];
  /** Every call, for assertions: `create <name>`, `start <id>`, `stop <id> <s>`, ... */
  readonly calls: string[] = [];
  private seq = 0;

  constructor(private readonly options: FakeEngineOptions = {}) {
    super('/nonexistent/fake-engine.sock');
  }

  /** Containers neither removed nor exited. */
  live(): FakeContainer[] {
    return this.containers.filter((c) => !c.removed && c.state !== 'exited');
  }

  /** Containers not yet removed. */
  present(): FakeContainer[] {
    return this.containers.filter((c) => !c.removed);
  }

  override info(): Promise<{ ID: string; ServerVersion: string; Name: string }> {
    return Promise.resolve({
      ID: this.options.daemonId ?? 'FAKE:DAEMON',
      ServerVersion: 'fake',
      Name: 'fake-engine',
    });
  }

  override version(): Promise<{ Version: string; ApiVersion: string }> {
    return Promise.resolve({ Version: 'fake', ApiVersion: '1.45' });
  }

  override async createContainer(name: string, body: unknown): Promise<string> {
    this.calls.push(`create ${name}`);
    const record = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    if (this.options.guard) {
      const checked = checkCreateBody(record, this.options.guard);
      if (!checked.ok)
        throw new EngineError(403, `docker-guard refused: ${checked.reasons.join('; ')}`);
    }
    if (this.present().some((c) => c.info.name === name)) {
      throw new EngineError(409, `Conflict. The container name "/${name}" is already in use`);
    }
    const id = `fake${String(++this.seq).padStart(4, '0')}${'0'.repeat(56)}`;
    const info = this.describe(id, name, record);
    const script = this.options.script?.(info) ?? {};
    if (script.createError) throw new EngineError(500, script.createError);
    this.containers.push({
      info,
      script,
      state: 'created',
      exitCode: 0,
      oomKilled: false,
      startedAt: ZERO_TIME,
      finishedAt: ZERO_TIME,
      removed: false,
      frames: [],
      followers: new Set(),
      exitWaiters: [],
      interrupt: () => {},
    });
    return id;
  }

  override async start(id: string): Promise<void> {
    this.calls.push(`start ${id}`);
    const c = this.get(id);
    if (c.script.startError) throw new EngineError(500, c.script.startError);
    if (c.state !== 'created') throw new EngineError(304, 'container already started');
    c.state = 'running';
    c.startedAt = new Date().toISOString();
    // A script that cannot write its files dies the way a crashing process would.
    this.play(c).catch((err: Error) => {
      this.write(c, 2, `fake trial failed: ${err.message}\n`);
      this.exit(c, 1);
    });
  }

  override async stop(id: string, seconds: number): Promise<void> {
    this.calls.push(`stop ${id} ${seconds}`);
    const c = this.find(id);
    if (!c || c.state !== 'running') return;
    if (!c.script.ignoreSigterm) return this.exit(c, 143);
    const exited = new Promise<void>((resolve) => c.exitWaiters.push(() => resolve()));
    const timer = setTimeout(() => this.exit(c, 137), seconds * 1000);
    await exited;
    clearTimeout(timer);
  }

  override async kill(id: string): Promise<void> {
    this.calls.push(`kill ${id}`);
    const c = this.find(id);
    if (c?.state === 'running') this.exit(c, 137);
  }

  override waitForExit(id: string): {
    registered: Promise<void>;
    exited: Promise<{ StatusCode: number }>;
  } {
    const c = this.find(id);
    if (!c) {
      const missing = Promise.reject(new EngineError(404, `No such container: ${id}`));
      missing.catch(() => {});
      return { registered: Promise.resolve(), exited: missing };
    }
    const exited = new Promise<{ StatusCode: number }>((resolve) =>
      c.exitWaiters.push((code) => resolve({ StatusCode: code })),
    );
    return { registered: Promise.resolve(), exited };
  }

  override async inspect(id: string): Promise<{
    Id: string;
    State: ContainerState;
    Config: { Labels: Record<string, string> };
  }> {
    const c = this.get(id);
    return {
      Id: id,
      State: {
        Status: c.state,
        Running: c.state === 'running',
        ExitCode: c.exitCode,
        OOMKilled: c.oomKilled,
        StartedAt: c.startedAt,
        FinishedAt: c.finishedAt,
      },
      Config: { Labels: { ...c.info.labels } },
    };
  }

  override async remove(id: string): Promise<void> {
    this.calls.push(`remove ${id}`);
    const c = this.find(id);
    if (!c) return;
    if (c.state === 'running') this.exit(c, 137);
    c.removed = true;
  }

  override async list(labels: string[]): Promise<ContainerSummary[]> {
    return this.present()
      .filter((c) =>
        labels.every((filter) => {
          const [key, value] = filter.split('=', 2) as [string, string | undefined];
          return key in c.info.labels && (value === undefined || c.info.labels[key] === value);
        }),
      )
      .map((c) => ({
        Id: c.info.id,
        Names: [`/${c.info.name}`],
        Labels: { ...c.info.labels },
        State: c.state,
        HostConfig: { NetworkMode: c.info.network },
      }));
  }

  override async logs(id: string): Promise<IncomingMessage> {
    const c = this.get(id);
    const stream = new IncomingMessage(new Socket());
    for (const f of c.frames) stream.push(f);
    if (c.state === 'exited') stream.push(null);
    else {
      c.followers.add(stream);
      stream.on('close', () => c.followers.delete(stream));
    }
    return stream;
  }

  private describe(id: string, name: string, body: Record<string, unknown>): FakeContainerInfo {
    const labels = (body.Labels ?? {}) as Record<string, string>;
    const env = Object.fromEntries(
      ((body.Env ?? []) as string[]).map((entry) => {
        const at = entry.indexOf('=');
        return [entry.slice(0, at), entry.slice(at + 1)];
      }),
    );
    const host = (body.HostConfig ?? {}) as { NetworkMode?: string };
    const attempt = labels['hermes-evals.attempt'];
    const root = this.options.trialsDir && attempt ? join(this.options.trialsDir, attempt) : null;
    return {
      id,
      name,
      body,
      labels: { ...labels },
      env,
      argv: [...((body.Entrypoint ?? []) as string[]), ...((body.Cmd ?? []) as string[])],
      network: host.NetworkMode ?? 'none',
      homeDir: root ? join(root, 'home') : null,
      workspaceDir: root ? join(root, 'workspace') : null,
    };
  }

  private async play(c: FakeContainer): Promise<void> {
    const stopped = new Promise<void>((resolve) => (c.interrupt = resolve));
    const running = () => c.state === 'running';
    for (const step of c.script.steps ?? []) {
      if (!running()) return;
      if ('sleep' in step) await Promise.race([sleep(step.sleep), stopped]);
      else if ('wait' in step) await Promise.race([step.wait.catch(() => {}), stopped]);
      else if ('stdout' in step) this.write(c, 1, `${step.stdout}\n`);
      else if ('stdoutRaw' in step) this.write(c, 1, step.stdoutRaw);
      else if ('stderr' in step) this.write(c, 2, step.stderr);
      else if ('symlink' in step) await this.link(c, step.symlink);
      else await this.writeFile(c, step.file);
    }
    if (!running()) return;
    if (c.script.hang) return;
    if (c.script.oomKilled) c.oomKilled = true;
    this.exit(c, c.script.oomKilled ? 137 : (c.script.exitCode ?? 0));
  }

  private write(c: FakeContainer, stream: 1 | 2, text: string): void {
    const f = frame(stream, Buffer.from(text, 'utf8'));
    c.frames.push(f);
    for (const follower of c.followers) follower.push(f);
  }

  private async writeFile(c: FakeContainer, file: FakeTrialFile): Promise<void> {
    const base = file.in === 'home' ? c.info.homeDir : c.info.workspaceDir;
    if (!base) throw new Error('FakeEngine needs trialsDir to write trial files');
    const target = join(base, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }

  private async link(
    c: FakeContainer,
    link: { in: 'workspace' | 'home'; path: string; target: string },
  ): Promise<void> {
    const base = link.in === 'home' ? c.info.homeDir : c.info.workspaceDir;
    if (!base) throw new Error('FakeEngine needs trialsDir to make trial links');
    const at = join(base, link.path);
    await mkdir(dirname(at), { recursive: true });
    await symlink(link.target, at);
  }

  private exit(c: FakeContainer, code: number): void {
    if (c.state === 'exited') return;
    c.state = 'exited';
    c.exitCode = code;
    c.finishedAt = new Date().toISOString();
    c.interrupt();
    for (const follower of c.followers) follower.push(null);
    c.followers.clear();
    for (const waiter of c.exitWaiters.splice(0)) waiter(code);
  }

  private find(id: string): FakeContainer | undefined {
    return this.containers.find((c) => c.info.id === id && !c.removed);
  }

  private get(id: string): FakeContainer {
    const c = this.find(id);
    if (!c) throw new EngineError(404, `No such container: ${id}`);
    return c;
  }
}

/** Canned Hermes stream-json lines (hermes_cli/stream_json.py at 4d04303), as the trial prints them. */
export const streamJson = {
  init: (model = 'mock/scripted', at = Date.now()): string =>
    JSON.stringify({ type: 'system', subtype: 'init', model, session_id: '', timestamp: at }),
  text: (text: string, at = Date.now()): string =>
    JSON.stringify({ type: 'text', text, timestamp: at }),
  toolUse: (name: string, input: Record<string, unknown>, id = 'call_0', at = Date.now()): string =>
    JSON.stringify({ type: 'tool_use', name, tool_call_id: id, input, timestamp: at }),
  toolResult: (name: string, output: string, id = 'call_0', at = Date.now()): string =>
    JSON.stringify({
      type: 'tool_result',
      name,
      tool_call_id: id,
      output,
      duration_ms: 12,
      is_error: false,
      timestamp: at,
    }),
  result: (
    options: {
      text?: string;
      exitCode?: number;
      error?: string;
      sessionId?: string;
      tokens?: { input: number; output: number; cache_read?: number; cache_write?: number };
      at?: number;
    } = {},
  ): string => {
    const tokens = options.tokens ?? { input: 3300, output: 63 };
    return JSON.stringify({
      type: 'result',
      session_id: options.sessionId ?? '20261024_120000_abcdef',
      exit_code: options.exitCode ?? 0,
      text: options.text ?? '',
      tokens: {
        input: tokens.input,
        output: tokens.output,
        total: tokens.input + tokens.output,
        cache_read: tokens.cache_read ?? 0,
        cache_write: tokens.cache_write ?? 0,
      },
      duration_ms: 1234,
      ...(options.error ? { error: options.error } : {}),
      timestamp: options.at ?? Date.now(),
    });
  },
};

/**
 * A typical successful Hermes run: init, one terminal call, the streamed
 * answer, then the `result` that carries it. `files` are written to the
 * workspace before the result, as the agent's tool calls would.
 */
export function hermesRun(
  answer: string,
  options: { files?: Array<{ path: string; content: string | Buffer }>; model?: string } = {},
): FakeTrialScript {
  return {
    steps: [
      { stdout: streamJson.init(options.model) },
      { stdout: streamJson.toolUse('terminal', { command: 'head -3 invoices.csv' }) },
      { stdout: streamJson.toolResult('terminal', 'invoice_no,vendor,amount') },
      ...(options.files ?? []).map((f) => ({ file: { in: 'workspace' as const, ...f } })),
      { stdout: streamJson.text(answer) },
      { stdout: streamJson.result({ text: answer }) },
    ],
    exitCode: 0,
  };
}

/** How the fake judge model answers one chat completion that egress forwarded. */
export interface FakeJudgeAnswer {
  /** The assistant message's content, on a 200. */
  content?: string;
  /** The upstream's status; 200 by default. */
  status?: number;
  /** The upstream's body for a status other than 200. */
  body?: unknown;
  promptTokens?: number;
  completionTokens?: number;
}

/** The model behind the fake judge path: sees each forwarded body and its registration. */
export type FakeJudgeModel = (
  body: EgressJudgeChatBody,
  registration: EgressJudgeRegistration,
) => FakeJudgeAnswer | Promise<FakeJudgeAnswer>;

/** One judge registration as the fake held it, with every body forwarded under it. */
export interface FakeJudgeRecord {
  judgeId: string;
  registration: EgressJudgeRegistration;
  bodies: EgressJudgeChatBody[];
}

const ZERO_USAGE: EgressUsage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export interface FakeEgressOptions {
  /** Refuse every registration with this message, as egress answers a bad one. */
  registerError?: string;
  /** What remove() reports for an attempt. Default: no calls and an empty log. */
  report?: (
    attemptId: string,
    registration: EgressRegistration,
  ) => { usage?: Partial<EgressUsage>; log?: EgressLogEntry[] };
  /** Answer of envNames(). */
  envNames?: string[];
  /** The development host forward healthReport() answers with; none by default. */
  hostProxy?: EgressHealth['hostProxy'];
  /** Serves the judge path with this model; absent, the judge path answers 404. */
  judge?: FakeJudgeModel;
}

export class FakeEgress extends EgressClient {
  /** Registrations currently live, by attempt id. */
  readonly registrations = new Map<string, EgressRegistration>();
  /** Every registration ever made, in order. */
  readonly history: Array<{ attemptId: string; registration: EgressRegistration }> = [];
  /** Attempt ids removed, in order. */
  readonly removed: string[] = [];
  /** Every remove call, in order, including those for attempts egress did not have. */
  readonly removeCalls: string[] = [];
  /** Judge registrations currently live, with what they used so far. */
  readonly judges = new Map<string, { usage: EgressUsage; log: EgressLogEntry[] }>();
  /** Every judge registration ever made, in order, with the bodies forwarded under it. */
  readonly judgeHistory: FakeJudgeRecord[] = [];
  /** Judge ids removed, in order. */
  readonly judgesRemoved: string[] = [];

  constructor(private readonly options: FakeEgressOptions = {}) {
    super('/nonexistent/fake-egress.sock');
  }

  override async register(attemptId: string, registration: EgressRegistration): Promise<void> {
    if (this.options.registerError) {
      throw new Error(`egress refused registration: ${this.options.registerError}`);
    }
    const copy = JSON.parse(JSON.stringify(registration)) as EgressRegistration;
    this.registrations.set(attemptId, copy);
    this.history.push({ attemptId, registration: copy });
  }

  override async remove(
    attemptId: string,
  ): Promise<{ usage: EgressUsage; log: EgressLogEntry[] } | null> {
    this.removeCalls.push(attemptId);
    const registration = this.registrations.get(attemptId);
    if (!registration) return null;
    this.registrations.delete(attemptId);
    this.removed.push(attemptId);
    const report = this.options.report?.(attemptId, registration) ?? {};
    return {
      usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, ...report.usage },
      log: report.log ?? [],
    };
  }

  override async registerJudge(
    judgeId: string,
    registration: EgressJudgeRegistration,
  ): Promise<void> {
    if (!this.options.judge) {
      throw new EgressCallError(
        'refused',
        'egress refused the judge registration (404): no judge path',
        404,
      );
    }
    if (registration.kind !== 'judge' || this.judges.has(judgeId)) {
      throw new EgressCallError(
        'refused',
        `egress refused the judge registration (409): ${judgeId} is already registered`,
        409,
      );
    }
    const copy = JSON.parse(JSON.stringify(registration)) as EgressJudgeRegistration;
    this.judges.set(judgeId, { usage: { ...ZERO_USAGE }, log: [] });
    this.judgeHistory.push({ judgeId, registration: copy, bodies: [] });
  }

  /** Egress's own refusal shape: its status and `{ error }`, no usage. */
  private judgeRefusal(status: number, message: string): EgressJudgeReply {
    return { status, body: { error: { message, type: 'invalid_request_error' } }, usage: null };
  }

  override async judgeComplete(
    judgeId: string,
    body: EgressJudgeChatBody,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<EgressJudgeReply> {
    const held = this.judges.get(judgeId);
    const record = this.judgeHistory.find((r) => r.judgeId === judgeId);
    if (!held || !record || !this.options.judge) {
      return this.judgeRefusal(404, `unknown judge registration ${judgeId}`);
    }
    if (body.model !== record.registration.model) {
      return this.judgeRefusal(403, `model ${body.model} is not this registration's`);
    }
    record.bodies.push(JSON.parse(JSON.stringify(body)) as EgressJudgeChatBody);
    if (options.signal?.aborted) throw new EgressCallError('aborted', 'the judge call was aborted');
    const answer = await this.options.judge(body, record.registration);
    const status = answer.status ?? 200;
    const promptTokens = answer.promptTokens ?? 0;
    const completionTokens = answer.completionTokens ?? 0;
    const usage: EgressUsage = {
      calls: 1,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
    held.usage = {
      calls: held.usage.calls + 1,
      promptTokens: held.usage.promptTokens + promptTokens,
      completionTokens: held.usage.completionTokens + completionTokens,
      totalTokens: held.usage.totalTokens + usage.totalTokens,
    };
    held.log.push({
      at: new Date().toISOString(),
      kind: 'model',
      model: body.model,
      decision: 'allowed',
      status,
      ms: 5,
      promptTokens,
      completionTokens,
    });
    if (status !== 200) return { status, body: answer.body ?? null, usage };
    return {
      status,
      body: {
        id: `chatcmpl-${judgeId}`,
        object: 'chat.completion',
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: answer.content ?? '' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: usage.totalTokens,
        },
      },
      usage,
    };
  }

  override async removeJudge(judgeId: string): Promise<EgressJudgeReport | null> {
    const held = this.judges.get(judgeId);
    if (!held) return null;
    this.judges.delete(judgeId);
    this.judgesRemoved.push(judgeId);
    return { usage: held.usage, log: held.log };
  }

  override async envNames(): Promise<string[]> {
    return [...(this.options.envNames ?? [])].sort();
  }

  override async health(): Promise<boolean> {
    return true;
  }

  /** Egress's GET /health: up, with no development host forward unless the options give one. */
  override async healthReport(): Promise<EgressHealth | null> {
    return {
      ok: true,
      attempts: this.registrations.size,
      ...(this.options.hostProxy ? { hostProxy: this.options.hostProxy } : {}),
    };
  }
}
