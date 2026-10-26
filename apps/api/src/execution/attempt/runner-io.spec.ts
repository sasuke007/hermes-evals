/**
 * What the attempt runner puts into a trial and takes out of it: secrets
 * (values only in the container environment, never in the home, the launch
 * record, events or the stderr tail), materialisation (only fixtures,
 * documents and skills, hashes re-checked), artifact origins and the 25 MB
 * skip, MCP routing through egress, the network log, and the attempt being
 * handed back on a lost lease, a shutdown or a cancel.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchRecordSchema, type McpServerInput } from '@hermes-evals/shared';
import { hermesRun, streamJson, type FakeTrialScript } from '../../../test/support/fake-engine.js';
import { LeaseLostError, WorkerShutdownError, type PlannedMcpServer } from '../contracts.js';
import {
  createAttemptWorld,
  MemorySink,
  POLICY_DOC,
  runnerKit,
  snapshotTree,
  type AttemptWorld,
} from './testing.helper-spec.js';

let world: AttemptWorld;

beforeEach(async () => {
  world = await createAttemptWorld();
});

afterEach(async () => {
  await world.cleanup();
});

const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

function mcpServer(definition: Partial<McpServerInput> & { name: string }): PlannedMcpServer {
  const full: McpServerInput = {
    transport: 'stdio',
    command: 'invoice-db-mcp',
    args: [],
    envNames: [],
    url: null,
    headers: [],
    include: [],
    exclude: [],
    timeoutS: 30,
    ...definition,
  };
  return {
    versionId: `v-${definition.name}`,
    name: definition.name,
    version: 1,
    transport: full.transport,
    definition: full,
    definitionHash: sha(JSON.stringify(full)),
  };
}

const SECRET = 'sk-live-6f1d2b9a77c4e0';
const DB_URL = 'file:///opt/mcp/invoice-db/invoices.csv';
const INVOICE_DB = mcpServer({
  name: 'invoice-db',
  envNames: ['INVOICE_DB_URL', 'INVOICE_DB_KEY'],
});

describe('secrets', () => {
  it('puts stdio values only in the container environment, and redacts every echo of them', async () => {
    const plan = world.plan({ configuration: { mcpServers: [INVOICE_DB] } });
    let home: Record<string, string> = {};
    const { runner, engine } = runnerKit(
      world,
      (info) => {
        home = snapshotTree(info.homeDir!);
        return {
          steps: [
            { stdout: streamJson.init() },
            { stdout: streamJson.toolUse('terminal', { command: 'env' }) },
            {
              stdout: streamJson.toolResult(
                'terminal',
                `INVOICE_DB_KEY=${SECRET}\nHERMES_EVALS_ATTEMPT_TOKEN=${plan.token}`,
              ),
            },
            { stderr: `connecting with key ${SECRET}\nstill fine\n` },
            // A noise line cut at 8,000 characters, the value across the cut.
            { stdout: `${'x'.repeat(7_990)}${SECRET} and more` },
            { file: { in: 'workspace', path: `notes-${SECRET}.txt`, content: SECRET } },
            { stdout: streamJson.result({ text: `I found the key ${SECRET}.` }) },
          ],
        };
      },
      { env: { INVOICE_DB_URL: DB_URL, INVOICE_DB_KEY: SECRET, UNRELATED: 'x' } },
    );
    const sink = new MemorySink(plan.attemptId);
    const outcome = await runner.run(plan, sink, new AbortController().signal);

    // The container gets the values; nothing else does.
    const env = engine.containers[0]!.info.env;
    expect(env.INVOICE_DB_KEY).toBe(SECRET);
    expect(env.INVOICE_DB_URL).toBe(DB_URL);
    expect(env.UNRELATED).toBeUndefined();
    for (const [path, content] of Object.entries(home)) {
      expect(content, path).not.toContain(SECRET);
      expect(content, path).not.toContain(DB_URL);
      expect(content, path).not.toContain(plan.token);
    }
    expect(home['config.yaml']).toContain('INVOICE_DB_KEY: ${INVOICE_DB_KEY}');
    expect(home['config.yaml']).toContain('- invoice-db');

    const record = JSON.stringify(sink.launch);
    expect(record).not.toContain(SECRET);
    expect(record).not.toContain(DB_URL);
    expect(record).not.toContain(plan.token);
    const parsed = LaunchRecordSchema.parse(sink.launch);
    expect(parsed.config_yaml).toContain('INVOICE_DB_KEY: <from env INVOICE_DB_KEY>');
    expect(parsed.secret_env_names).toEqual(
      expect.arrayContaining(['INVOICE_DB_KEY', 'INVOICE_DB_URL', 'HERMES_EVALS_ATTEMPT_TOKEN']),
    );
    expect(parsed.mcp_servers).toEqual([
      expect.objectContaining({ name: 'invoice-db', transport: 'stdio', version: 1 }),
    ]);

    const stored = JSON.stringify([sink.events, outcome.finalEvents]);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(plan.token);
    expect(stored).toContain('<from env INVOICE_DB_KEY>');
    expect(stored).toContain('<from env HERMES_EVALS_ATTEMPT_TOKEN>');
    expect(outcome.finalText).toBe('I found the key <from env INVOICE_DB_KEY>.');
    expect(outcome.stderrTail).toBe('connecting with key <from env INVOICE_DB_KEY>\nstill fine');
    // The whole of stderr.log is counted, for the inspector's "last 40 of N lines".
    const collected = outcome.finalEvents.find((e) => e.payload.subtype === 'collected')!;
    expect(collected.payload.stderr_lines).toBe(2);
    const noise = sink.events.find((e) => e.payload.subtype === 'noise')!;
    expect(noise.payload).toMatchObject({ truncated: true });
    // Redacted whole, then cut: no prefix of the value survives the cut.
    expect(String(noise.payload.line).endsWith('x<from env ')).toBe(true);
    expect(String(noise.payload.line)).not.toContain('sk-');
    // tool_result (2 values), the noise line, the result text, and the stderr tail.
    expect(outcome.redactions).toBe(5);
    expect(outcome.errorMessage).toBeNull();
  });

  it('ends as setup, naming the variable, when a stdio value is missing or empty', async () => {
    const plan = world.plan({ configuration: { mcpServers: [INVOICE_DB] } });
    const { runner, engine, egress } = runnerKit(world, () => hermesRun('x'), {
      env: { INVOICE_DB_URL: DB_URL, INVOICE_DB_KEY: '' },
    });
    const sink = new MemorySink(plan.attemptId);
    const outcome = await runner.run(plan, sink, new AbortController().signal);
    expect(outcome).toMatchObject({
      status: 'execution_error',
      category: 'setup',
      exitCode: null,
      artifacts: [],
      finalEvents: [],
    });
    expect(outcome.errorMessage).toContain('INVOICE_DB_KEY is not set in the worker environment');
    expect(sink.calls).toEqual([]);
    expect(engine.containers).toEqual([]);
    expect(egress.history).toEqual([]);
    expect(existsSync(plan.paths.root)).toBe(false);
  });

  it('refuses a reserved name and a name an http server of the attempt uses as a header variable', async () => {
    const env = { OPENAI_API_KEY: 'sk-x', VENDOR_TOKEN: 'v' };
    for (const [servers, message] of [
      [[mcpServer({ name: 'db', envNames: ['OPENAI_API_KEY'] })], 'OPENAI_API_KEY is a platform'],
      [
        [
          mcpServer({ name: 'db', envNames: ['VENDOR_TOKEN'] }),
          mcpServer({
            name: 'vendor',
            transport: 'http',
            command: null,
            url: 'https://mcp.example.com/mcp',
            headers: [{ header: 'Authorization', env: 'VENDOR_TOKEN' }],
          }),
        ],
        'VENDOR_TOKEN is the header variable of http server vendor',
      ],
    ] as const) {
      const plan = world.plan({ configuration: { mcpServers: [...servers] } });
      const { runner, engine } = runnerKit(world, () => hermesRun('x'), { env });
      const outcome = await runner.run(
        plan,
        new MemorySink(plan.attemptId),
        new AbortController().signal,
      );
      expect(outcome.category).toBe('setup');
      expect(outcome.errorMessage).toContain(message);
      expect(engine.containers).toEqual([]);
    }
  });
});

describe('materialisation', () => {
  it('places only the fixtures, documents and skills, plus what Hermes needs', async () => {
    const plan = world.plan();
    let home: Record<string, string> = {};
    let workspace: Record<string, string> = {};
    const { runner } = runnerKit(world, (info) => {
      home = snapshotTree(info.homeDir!);
      workspace = snapshotTree(info.workspaceDir!);
      return hermesRun('ok');
    });
    await runner.run(plan, new MemorySink(plan.attemptId), new AbortController().signal);
    expect(Object.keys(workspace).sort()).toEqual(['docs/policy.md', 'invoices.csv']);
    expect(workspace['docs/policy.md']).toBe(POLICY_DOC);
    expect(Object.keys(home).sort()).toEqual([
      '.no-bundled-skills',
      'config.yaml',
      'skills/invoice-audit/SKILL.md',
      'skills/invoice-audit/scripts/check.py',
      'task.txt',
    ]);
    expect(home['task.txt']).toBe(plan.task.prompt);
  });

  it('is setup, with no container, when a fixture blob no longer matches its hash', async () => {
    const plan = world.plan();
    await writeFile(world.blobs.path(world.fixtureSha), 'tampered\n');
    const { runner, engine } = runnerKit(world, () => hermesRun('x'));
    const sink = new MemorySink(plan.attemptId);
    const outcome = await runner.run(plan, sink, new AbortController().signal);
    expect(outcome.category).toBe('setup');
    expect(outcome.errorMessage).toBe(
      'fixture invoices.csv does not match its recorded hash: the blob store copy has changed',
    );
    expect(sink.launch).toBeNull();
    expect(engine.containers).toEqual([]);
    expect(existsSync(plan.paths.home)).toBe(false);
  });

  it('is setup when a stored skill tree changed or holds a link', async () => {
    const tree = join(world.skillsDir, world.skillHash);
    await writeFile(join(tree, 'SKILL.md'), 'changed');
    let plan = world.plan();
    let kit = runnerKit(world, () => hermesRun('x'));
    let outcome = await kit.runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    expect(outcome.errorMessage).toContain('does not match its content hash');

    await symlink('/etc/passwd', join(tree, 'passwd'));
    plan = world.plan();
    kit = runnerKit(world, () => hermesRun('x'));
    outcome = await kit.runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    expect(outcome.errorMessage).toContain('holds something other than folders and files: passwd');
    expect(kit.engine.containers).toEqual([]);
  });

  it('refuses a fixture path that could leave the workspace, and a directory that already exists', async () => {
    let plan = world.plan({
      task: { fixtures: [{ path: '../escape.csv', sha256: world.fixtureSha, size: 1 }] },
    });
    let kit = runnerKit(world, () => hermesRun('x'));
    let outcome = await kit.runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    expect(outcome.errorMessage).toContain('not a plain relative path');

    plan = world.plan();
    await mkdir(plan.paths.root);
    kit = runnerKit(world, () => hermesRun('x'));
    outcome = await kit.runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    expect(outcome.errorMessage).toContain('could not be created fresh (EEXIST)');
    // Not ours: left exactly as it was.
    expect(existsSync(plan.paths.root)).toBe(true);
  });
});

describe('artifacts', () => {
  it('labels each file by origin, skips files over 25 MB, and lists links without following them', async () => {
    const plan = world.plan();
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
    const run = hermesRun('done', {
      files: [
        { path: 'invoices.csv', content: 'invoice_no,amount\nINV-1,1\n' },
        { path: 'out/summary.csv', content: 'total\n1042\n' },
        { path: 'huge.bin', content: big },
      ],
    });
    // A link the agent made, pointing at the other attempts' directories.
    run.steps!.push({ symlink: { in: 'workspace', path: 'escape', target: world.trialsDir } });
    const { runner } = runnerKit(world, () => run);
    const outcome = await runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    const byPath = Object.fromEntries(outcome.artifacts.map((a) => [a.path, a]));
    expect(Object.keys(byPath).sort()).toEqual([
      'docs/policy.md',
      'huge.bin',
      'invoices.csv',
      'out/summary.csv',
    ]);
    expect(byPath['docs/policy.md']).toMatchObject({
      origin: 'document_unchanged',
      sha256: world.docSha,
      skippedReason: null,
    });
    expect(byPath['invoices.csv']).toMatchObject({ origin: 'fixture_modified' });
    expect(byPath['out/summary.csv']).toMatchObject({
      origin: 'agent',
      sha256: sha('total\n1042\n'),
      size: 11,
    });
    expect(byPath['huge.bin']).toEqual({
      root: 'workspace',
      path: 'huge.bin',
      origin: 'agent',
      size: big.length,
      sha256: null,
      skippedReason: 'too_large',
    });
    expect(await world.blobs.read(sha('total\n1042\n'))).toEqual(Buffer.from('total\n1042\n'));
    const collected = outcome.finalEvents.find((e) => e.payload.subtype === 'collected')!;
    expect(collected.payload).toMatchObject({
      files: 4,
      stored: 3,
      too_large: ['huge.bin'],
      not_collected: [{ path: 'escape', kind: 'symlink', detail: world.trialsDir }],
      deleted_inputs: [],
    });
    // The workspace stays for retention; the home is gone.
    expect((await readdir(plan.paths.workspace)).sort()).toEqual([
      'docs',
      'escape',
      'huge.bin',
      'invoices.csv',
      'out',
    ]);
    expect(existsSync(plan.paths.home)).toBe(false);
  });

  it('collects the memory files left in the home before deleting it, labelled against the seeds', async () => {
    const seed = await world.blobs.putBuffer(Buffer.from('Works in Lisbon.'));
    const plan = world.plan({
      task: { homeSeeds: [{ path: 'memories/USER.md', sha256: seed.sha256, size: seed.size }] },
    });
    const run = hermesRun('done');
    run.steps!.push(
      {
        file: {
          in: 'home',
          path: 'memories/USER.md',
          content: 'Works in Lisbon.\n§\nReports in EUR.',
        },
      },
      { file: { in: 'home', path: 'memories/MEMORY.md', content: 'ACME is one vendor.' } },
      // Nothing else of the home is collected, and no link is followed.
      { file: { in: 'home', path: 'notes.txt', content: 'not collected' } },
      { symlink: { in: 'home', path: 'memories/escape', target: world.trialsDir } },
    );
    const { runner } = runnerKit(world, () => run);
    const sink = new MemorySink(plan.attemptId);
    const outcome = await runner.run(plan, sink, new AbortController().signal);
    expect(
      outcome.artifacts.filter((a) => a.root === 'home').map((a) => [a.path, a.origin]),
    ).toEqual([
      ['memories/MEMORY.md', 'agent'],
      ['memories/USER.md', 'home_seed_modified'],
    ]);
    const collected = outcome.finalEvents.find((e) => e.payload.subtype === 'collected')!;
    expect(collected.payload).toMatchObject({
      home_files: 2,
      home_agent_files: 1,
      home_not_collected: [
        { path: 'home/memories/escape', kind: 'symlink', detail: world.trialsDir },
      ],
      deleted_home_seeds: [],
    });
    expect(
      LaunchRecordSchema.parse(sink.launch).inputs.filter((i) => i.source === 'home_seed'),
    ).toEqual([{ path: 'memories/USER.md', sha256: seed.sha256, source: 'home_seed' }]);
    expect(existsSync(plan.paths.home)).toBe(false);
  });
});

describe('MCP and the network', () => {
  it('routes http servers through the gateway with the token reference, and opens public mode for web', async () => {
    const vendor = mcpServer({
      name: 'vendor',
      transport: 'http',
      command: null,
      url: 'https://mcp.vendor.example/mcp',
      headers: [{ header: 'X-Api-Key', env: 'VENDOR_TOKEN' }],
    });
    const plan = world.plan({ configuration: { mcpServers: [vendor], toolsets: ['web'] } });
    let home: Record<string, string> = {};
    const { runner, egress, engine } = runnerKit(
      world,
      (info) => {
        home = snapshotTree(info.homeDir!);
        return hermesRun('ok');
      },
      { egress: { envNames: ['VENDOR_TOKEN'] } },
    );
    await runner.run(plan, new MemorySink(plan.attemptId), new AbortController().signal);
    expect(egress.history[0]!.registration).toMatchObject({
      mode: 'public',
      allowHosts: [],
      mcp: [
        {
          name: 'vendor',
          url: 'https://mcp.vendor.example/mcp',
          headers: [{ header: 'X-Api-Key', env: 'VENDOR_TOKEN' }],
        },
      ],
    });
    expect(home['config.yaml']).toContain('url: http://egress:8080/mcp/vendor');
    expect(home['config.yaml']).toContain('Authorization: Bearer ${HERMES_EVALS_ATTEMPT_TOKEN}');
    expect(home['config.yaml']).not.toContain('X-Api-Key');
    expect(engine.containers[0]!.info.argv).toContain('web,vendor');
  });

  it('opens public mode for the browser toolset, and allowlist mode for anything else', async () => {
    for (const [toolsets, mode] of [
      [['browser'], 'public'],
      [['file', 'terminal'], 'allowlist'],
    ] as const) {
      const plan = world.plan({ configuration: { toolsets: [...toolsets], mcpServers: [] } });
      const { runner, egress } = runnerKit(world, () => hermesRun('ok'));
      await runner.run(plan, new MemorySink(plan.attemptId), new AbortController().signal);
      expect(egress.history[0]!.registration, toolsets.join(',')).toMatchObject({
        mode,
        allowHosts: [],
      });
    }
  });

  it('ends as setup, naming the variable, when egress lacks an http server header variable', async () => {
    const vendor = mcpServer({
      name: 'vendor-api',
      transport: 'http',
      command: null,
      url: 'https://mcp.vendor.example/mcp',
      headers: [
        { header: 'Authorization', env: 'VENDOR_API_TOKEN' },
        { header: 'X-Org', env: 'VENDOR_ORG' },
      ],
    });
    const plan = world.plan({ configuration: { mcpServers: [vendor] } });
    const { runner, egress, engine } = runnerKit(world, () => hermesRun('ok'), {
      egress: { envNames: ['VENDOR_ORG'] },
    });
    const outcome = await runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'setup' });
    expect(outcome.errorMessage).toBe(
      'VENDOR_API_TOKEN is not set in the egress environment; the MCP server vendor-api cannot start.',
    );
    // Refused before anything existed: no container, no registration, no directories.
    expect(engine.containers).toEqual([]);
    expect(egress.history).toEqual([]);
    expect(existsSync(plan.paths.root)).toBe(false);
  });

  it('ends as setup when Hermes ran on without an MCP server that failed to start', async () => {
    // Hermes parks a server that fails to connect, runs without its tools and still prints a
    // result; its errors.log, in the home, is the only record (mcp-start.ts).
    const broken = mcpServer({ name: 'broken', command: '/opt/nope/broken-mcp' });
    const plan = world.plan({ configuration: { mcpServers: [INVOICE_DB, broken] } });
    const run = hermesRun('```json\n{"total": 1042}\n```');
    const failure =
      "2026-10-24 23:19:12,149 WARNING tools.mcp_tool: Failed to connect to MCP server 'broken' " +
      "(command=/opt/nope/broken-mcp): missing executable '/opt/nope/broken-mcp'\n";
    const { runner } = runnerKit(
      world,
      () => ({
        ...run,
        steps: [{ file: { in: 'home', path: 'logs/errors.log', content: failure } }, ...run.steps!],
      }),
      { env: { INVOICE_DB_URL: DB_URL, INVOICE_DB_KEY: SECRET } },
    );
    const outcome = await runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'setup', exitCode: 0 });
    expect(outcome.errorMessage).toBe(
      "MCP server broken failed to start: missing executable '/opt/nope/broken-mcp'. Hermes ran without its tools, so the run is not scored.",
    );
    // Read before the home went, which still goes.
    expect(existsSync(plan.paths.home)).toBe(false);
  });

  it('stays executed when errors.log names no server of the attempt', async () => {
    const plan = world.plan({ configuration: { mcpServers: [INVOICE_DB] } });
    const run = hermesRun('```json\n{"total": 1042}\n```');
    const other =
      "x WARNING tools.mcp_tool: Failed to connect to MCP server 'invoice-db-2' (command=y): gone\n" +
      'x WARNING hermes_cli.post_update: config migration skipped\n';
    const { runner } = runnerKit(
      world,
      () => ({
        ...run,
        steps: [{ file: { in: 'home', path: 'logs/errors.log', content: other } }, ...run.steps!],
      }),
      { env: { INVOICE_DB_URL: DB_URL, INVOICE_DB_KEY: SECRET } },
    );
    const outcome = await runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ status: 'executed', category: null, errorMessage: null });
  });

  it('ends as setup when egress cannot say which variables it holds, or would refuse the route', async () => {
    const vendor = mcpServer({
      name: 'vendor-api',
      transport: 'http',
      command: null,
      url: 'https://mcp.vendor.example/mcp',
      headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }],
    });
    const down = runnerKit(world, () => hermesRun('ok'));
    down.egress.envNames = () => Promise.reject(new Error('egress GET /env-names timed out'));
    const plan = world.plan({ configuration: { mcpServers: [vendor] } });
    const outcome = await down.runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'setup' });
    expect(outcome.errorMessage).toMatch(
      /Egress could not be asked .*timed out.*vendor-api cannot start/,
    );
    expect(down.engine.containers).toEqual([]);

    // A definition saved before the API refused Proxy-Authenticate is refused by name.
    const stale = mcpServer({
      name: 'stale',
      transport: 'http',
      command: null,
      url: 'https://mcp.vendor.example/mcp',
      headers: [{ header: 'Proxy-Authenticate', env: 'VENDOR_API_TOKEN' }],
    });
    const kit = runnerKit(world, () => hermesRun('ok'), {
      egress: { envNames: ['VENDOR_API_TOKEN'] },
    });
    const refusedPlan = world.plan({ configuration: { mcpServers: [stale] } });
    const refused = await kit.runner.run(
      refusedPlan,
      new MemorySink(refusedPlan.attemptId),
      new AbortController().signal,
    );
    expect(refused.errorMessage).toBe(
      'The MCP server stale cannot be routed through egress: egress sets proxy-authenticate itself.',
    );
    expect(kit.egress.history).toEqual([]);
  });

  it('turns the connection log into network events and marks Hermes background calls', async () => {
    const plan = world.plan({
      configuration: { provider: 'nous', baseUrl: null, model: 'openai/gpt-6.1-sol' },
    });
    const { runner } = runnerKit(world, () => hermesRun('ok'), {
      egress: {
        report: () => ({
          usage: { calls: 1, promptTokens: 3300, completionTokens: 63, totalTokens: 3363 },
          log: [
            {
              at: '2026-10-24T12:00:00.000Z',
              kind: 'connect',
              host: 'inference-api.nousresearch.com',
              port: 443,
              decision: 'denied',
              reason: 'allowlist',
            },
            {
              at: '2026-10-24T12:00:01.000Z',
              kind: 'model',
              model: 'openai/gpt-6.1-sol',
              decision: 'allowed',
              status: 200,
              ms: 812.4,
            },
            {
              at: 'not a time',
              kind: 'connect',
              host: 'example.com',
              port: 443,
              decision: 'denied',
            },
          ],
        }),
      },
    });
    const outcome = await runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    const network = outcome.finalEvents.filter((e) => e.payload.subtype === 'network');
    expect(network.map((e) => e.payload)).toEqual([
      {
        type: 'platform',
        subtype: 'network',
        kind: 'connect',
        host: 'inference-api.nousresearch.com',
        port: 443,
        decision: 'denied',
        reason: 'allowlist',
        background: true,
      },
      {
        type: 'platform',
        subtype: 'network',
        kind: 'model',
        decision: 'allowed',
        status: 200,
        ms: 812,
        model: 'openai/gpt-6.1-sol',
        background: false,
      },
      expect.objectContaining({ host: 'example.com', background: false }),
    ]);
    expect(network[0]!.ts).toBe(Date.parse('2026-10-24T12:00:00.000Z'));
    expect(outcome.egressUsage).toEqual({
      calls: 1,
      promptTokens: 3300,
      completionTokens: 63,
      totalTokens: 3363,
    });
    const collected = outcome.finalEvents.find((e) => e.payload.subtype === 'collected')!;
    expect(collected.payload.token_check).toMatchObject({ agrees: true, egress_prompt: 3300 });
  });
});

describe('handing the attempt back', () => {
  const hanging: FakeTrialScript = {
    steps: [{ stdout: streamJson.init() }, { stdout: streamJson.text('working') }],
    hang: true,
  };

  it('a lost lease on an event write stops the container, removes it from egress, and rethrows', async () => {
    const plan = world.plan();
    const { runner, engine, egress } = runnerKit(world, () => hanging);
    const sink = new MemorySink(plan.attemptId);
    sink.loseLeaseOnAppend = 1;
    await expect(runner.run(plan, sink, new AbortController().signal)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(engine.present()).toEqual([]);
    expect(egress.removed).toEqual([plan.attemptId]);
    // Recovery or retention deletes the directories, not a worker that lost the attempt.
    expect(existsSync(plan.paths.home)).toBe(true);
  });

  it('a lost lease when the launch is recorded starts no container', async () => {
    const plan = world.plan();
    const { runner, engine, egress } = runnerKit(world, () => hanging);
    const sink = new MemorySink(plan.attemptId);
    sink.loseLeaseOnLaunch = true;
    await expect(runner.run(plan, sink, new AbortController().signal)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(engine.containers).toEqual([]);
    expect(egress.history).toEqual([]);
  });

  it('a lease the lifecycle finds lost, or a shutdown, aborts the run and is rethrown', async () => {
    for (const reason of [new LeaseLostError('x'), new WorkerShutdownError()]) {
      const plan = world.plan();
      const { runner, engine, egress } = runnerKit(world, () => hanging);
      const sink = new MemorySink(plan.attemptId);
      const controller = new AbortController();
      setTimeout(() => controller.abort(reason), 150);
      await expect(runner.run(plan, sink, controller.signal)).rejects.toBe(reason);
      expect(engine.present()).toEqual([]);
      expect(egress.removed).toEqual([plan.attemptId]);
      if (reason instanceof WorkerShutdownError) {
        // The sink still takes writes on shutdown: what streamed is kept.
        expect(sink.events.map((e) => e.type)).toEqual(['platform', 'system', 'text']);
      }
    }
  });

  it('Cancel, from the sink or the signal, stops the container and ends the attempt cancelled', async () => {
    for (const how of ['sink', 'signal'] as const) {
      const plan = world.plan();
      const { runner, engine } = runnerKit(world, () => ({
        ...hanging,
        steps: [
          ...hanging.steps!,
          { file: { in: 'workspace', path: 'partial.txt', content: 'half' } },
        ],
      }));
      const sink = new MemorySink(plan.attemptId);
      const controller = new AbortController();
      setTimeout(() => (how === 'sink' ? (sink.cancel = true) : controller.abort()), 150);
      const outcome = await runner.run(plan, sink, controller.signal);
      expect(outcome).toMatchObject({ status: 'cancelled', category: null, exitCode: 143 });
      expect(outcome.finalEvents.map((e) => e.payload.subtype)).toEqual(['cancelled', 'collected']);
      expect(outcome.artifacts.map((a) => a.path)).toContain('partial.txt');
      expect(engine.present()).toEqual([]);
      expect(existsSync(plan.paths.home)).toBe(false);
    }
  });

  it('an attempt aborted before it starts is thrown back or cancelled without touching anything', async () => {
    const plan = world.plan();
    const { runner, engine } = runnerKit(world, () => hanging);
    const lost = new AbortController();
    lost.abort(new LeaseLostError(plan.attemptId));
    await expect(
      runner.run(plan, new MemorySink(plan.attemptId), lost.signal),
    ).rejects.toBeInstanceOf(LeaseLostError);
    const cancelled = new AbortController();
    cancelled.abort();
    const outcome = await runner.run(plan, new MemorySink(plan.attemptId), cancelled.signal);
    expect(outcome).toMatchObject({
      status: 'cancelled',
      exitCode: null,
      finalEvents: [expect.anything()],
    });
    expect(engine.containers).toEqual([]);
    expect(existsSync(plan.paths.root)).toBe(false);
  });
});
