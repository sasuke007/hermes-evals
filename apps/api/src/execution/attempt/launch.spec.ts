import { checkCreateBody } from '@hermes-evals/docker-guard/policy';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LaunchRecordSchema, type McpServerInput } from '@hermes-evals/shared';
import { trialConfig } from '../../sandbox/hermes-smoke.js';
import { DEFAULT_LIMITS, trialContainerBody } from '../../sandbox/trial-spec.js';
import type { AttemptPlan, PlannedMcpServer } from '../contracts.js';
import { buildTrialLaunch, hermesChatCmd, SWEEP_MARGIN_S } from './launch.js';
import { attemptConfig, configYaml, displayConfigYaml, trialToolsets } from './trial-config.js';

const ATTEMPT = '01K8ZQ7M3V5X9C2B4N6P8R0T1W';
const RUN = '01K8ZQ7M3V5X9C2B4N6P8R0T1X';
const TOKEN = 'tok_'.padEnd(43, 'Z');
const HASH = 'a'.repeat(64);

const server = (def: Partial<McpServerInput> & { name: string }): PlannedMcpServer => {
  const definition: McpServerInput = {
    transport: 'stdio',
    command: 'invoice-db-mcp',
    args: ['--readonly'],
    envNames: [],
    url: null,
    headers: [],
    include: [],
    exclude: [],
    timeoutS: 30,
    ...def,
  };
  return {
    versionId: `v-${def.name}`,
    name: def.name,
    version: 2,
    transport: definition.transport,
    definition,
    definitionHash: HASH,
  };
};

const plan = (configuration: Partial<AttemptPlan['configuration']> = {}): AttemptPlan => ({
  experimentId: 'E',
  runId: RUN,
  attemptId: ATTEMPT,
  attemptNumber: 1,
  token: TOKEN,
  slot: 'hermes-evals-trial-1',
  paths: {
    root: `/trials/${ATTEMPT}`,
    home: `/trials/${ATTEMPT}/home`,
    workspace: `/trials/${ATTEMPT}/workspace`,
  },
  task: { id: 'T', key: 'total_due', prompt: 'p', fixtures: [] },
  limits: { maxTurns: 12, runBudgetS: 300 },
  configuration: {
    versionId: 'CV',
    name: 'baseline',
    version: 1,
    model: 'openai/gpt-6.1-sol',
    provider: 'nous',
    baseUrl: null,
    toolsets: ['file', 'terminal'],
    memoryEnabled: true,
    skills: [],
    documents: [],
    mcpServers: [
      server({ name: 'invoice-db', envNames: ['INVOICE_DB_URL'] }),
      server({
        name: 'vendor',
        transport: 'http',
        command: null,
        args: [],
        url: 'https://mcp.vendor.example/mcp',
        headers: [{ header: 'X-Api-Key', env: 'VENDOR_TOKEN' }],
        include: ['lookup_*'],
      }),
    ],
    ...configuration,
  },
  hermes: { version: '0.22.4', revision: '4d04303' },
});

const SETTINGS = {
  image: 'hermes-evals/trial:v0.22.4-4d04303',
  volume: 'hermes-evals-trials',
  imagePath: '/opt/hermes/.venv/bin:/usr/bin:/bin',
  deadlineGraceS: 60,
  stopGraceS: 10,
  diskLimit: { maxBytes: 2 * 1024 ** 3, maxEntries: 50_000 },
  limits: DEFAULT_LIMITS,
};

describe('config.yaml', () => {
  it('carries the plan 8.2 settings, references for every secret, and no value or token', () => {
    const yaml = configYaml(attemptConfig(plan()));
    const config = parse(yaml) as Record<string, unknown>;
    expect(config).toEqual({
      model: {
        default: 'openai/gpt-6.1-sol',
        provider: 'nous',
        base_url: 'http://egress:8080/v1',
        context_length: 131072,
      },
      toolsets: ['file', 'terminal', 'invoice-db', 'vendor'],
      memory: { memory_enabled: true, user_profile_enabled: true },
      mcp_servers: {
        'invoice-db': {
          command: 'invoice-db-mcp',
          args: ['--readonly'],
          env: { INVOICE_DB_URL: '${INVOICE_DB_URL}' },
          timeout: 30,
        },
        vendor: {
          url: 'http://egress:8080/mcp/vendor',
          tools: { include: ['lookup_*'] },
          timeout: 30,
          headers: { Authorization: 'Bearer ${HERMES_EVALS_ATTEMPT_TOKEN}' },
        },
      },
      agent: { max_turns: 12, run_budget_seconds: 300 },
      tools: { tool_search: { enabled: 'off' } },
      approvals: { mode: 'off' },
      updates: { check: false },
      plugins: { auto_update_check_hours: 0 },
      curator: { enabled: false },
      auxiliary: {
        title_generation: { enabled: false },
        compression: { provider: 'auto', model: '', base_url: '' },
      },
      security: { allow_lazy_installs: false, protected_instruction_files: false },
      gateway: { unmanaged_idle_exit_seconds: 5 },
    });
    expect(yaml).not.toContain(TOKEN);
    expect(yaml).not.toContain('X-Api-Key');
    expect(displayConfigYaml(yaml)).toContain('INVOICE_DB_URL: <from env INVOICE_DB_URL>');
    expect(displayConfigYaml(yaml)).toContain('Bearer <from env HERMES_EVALS_ATTEMPT_TOKEN>');
    expect(displayConfigYaml(yaml)).not.toContain('${');
  });

  it('turns tool_search off in the text Hermes reads, whichever YAML version reads it', () => {
    // Hermes's loader reads a bare `off` as false (YAML 1.1), which its
    // ToolSearchConfig maps to "off" (_tri_state); a YAML 1.2 reader sees the
    // string itself. Either way the bridge stays off.
    const yaml = configYaml(attemptConfig(plan({ mcpServers: [] })));
    expect(yaml).toMatch(/^tools:\n {2}tool_search:\n {4}enabled: "?off"?$/m);
    const read12 = parse(yaml) as { tools: { tool_search: { enabled: unknown } } };
    expect(read12.tools.tool_search).toEqual({ enabled: 'off' });
    const read11 = parse(yaml, { version: '1.1' }) as typeof read12;
    expect([false, 'off']).toContain(read11.tools.tool_search.enabled);
  });

  it('keeps the sandbox harness on the same builder', () => {
    const config = trialConfig({
      model: 'mock/scripted',
      provider: 'custom',
      maxTurns: 6,
      budgetSeconds: 180,
      toolsets: ['terminal', 'file'],
    });
    expect(config).toMatchObject({
      model: { default: 'mock/scripted', provider: 'custom', base_url: 'http://egress:8080/v1' },
      memory: { memory_enabled: false, user_profile_enabled: false },
      mcp_servers: {},
      agent: { max_turns: 6, run_budget_seconds: 180 },
      tools: { tool_search: { enabled: 'off' } },
      gateway: { unmanaged_idle_exit_seconds: 5 },
    });
  });

  it('lists each MCP server once after the toolsets', () => {
    expect(trialToolsets(['file', 'web'], ['db', 'file'])).toEqual(['file', 'web', 'db']);
  });
});

describe('the launch', () => {
  it('runs hermes chat with the gateway route, the aliases, skills and limits', () => {
    const p = plan({
      skills: [{ id: 'S', name: 'invoice-audit', version: '1.0.0', contentHash: HASH }],
    });
    expect(hermesChatCmd(p)).toEqual([
      'chat',
      '--query-file',
      '/opt/data/task.txt',
      '--oneshot',
      '--format',
      'stream-json',
      '--provider',
      'nous',
      '-m',
      'openai/gpt-6.1-sol',
      '--base-url',
      'http://egress:8080/v1',
      '--api-key',
      TOKEN,
      '-t',
      'file,terminal,invoice-db,vendor',
      '-s',
      'invoice-audit',
      '--max-turns',
      '12',
      '--yolo',
      '--in',
      '/workspace',
    ]);
    expect(hermesChatCmd(plan({ toolsets: [], mcpServers: [] }))).not.toContain('-t');
  });

  it('builds a body docker-guard accepts, and a record with names, placeholders and limits only', () => {
    const p = plan();
    const now = 1_800_000_000_000;
    const launch = buildTrialLaunch(
      p,
      {
        configYaml: configYaml(attemptConfig(p)),
        inputs: [],
        values: { INVOICE_DB_URL: 'file:///secret' },
      },
      SETTINGS,
      now,
    );
    const body = JSON.parse(JSON.stringify(trialContainerBody(launch.spec)));
    const guard = {
      trialImage: SETTINGS.image,
      trialVolume: SETTINGS.volume,
      trialNetworks: ['hermes-evals-trial-1'],
    };
    const checked = checkCreateBody(body, guard);
    expect(checked.ok ? 'accepted' : checked.reasons).toBe('accepted');
    expect(launch.spec.env.INVOICE_DB_URL).toBe('file:///secret');
    expect(launch.deadlineMs).toBe(360_000);
    // The SIGKILL deadline (370 s) plus the sweep's margin.
    expect(launch.spec.deadline).toBe(1_800_000_370 + SWEEP_MARGIN_S);
    expect(launch.egressExpiresAt).toBe(now + 370_000 + 60_000);

    const record = LaunchRecordSchema.parse(launch.record);
    expect(JSON.stringify(launch.record)).not.toContain('file:///secret');
    expect(JSON.stringify(launch.record)).not.toContain(TOKEN);
    expect(record.argv[0]).toBe('/opt/hermes/.venv/bin/hermes');
    expect(record.argv[record.argv.indexOf('--api-key') + 1]).toBe('<attempt-token>');
    expect(record.env).toEqual({
      HERMES_HOME: '/opt/data',
      HOME: '/opt/data',
      PATH: '/opt/hermes/.venv/bin:/usr/bin:/bin',
    });
    expect(record.secret_env_names).toEqual([
      'HERMES_EVALS_ATTEMPT_TOKEN',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'INVOICE_DB_URL',
      'http_proxy',
      'https_proxy',
    ]);
    expect(record.limits).toEqual({
      max_turns: 12,
      run_budget_seconds: 300,
      deadline_seconds: 370,
    });
    expect(record.mcp_servers.map((s) => [s.name, s.transport, s.version])).toEqual([
      ['invoice-db', 'stdio', 2],
      ['vendor', 'http', 2],
    ]);
    expect(launch.record.container).toMatchObject({
      network: 'hermes-evals-trial-1',
      limits: { memory_mib: 1536, cpus: 1, pids: 1024, tmp_mib: 512 },
      mounts: [
        { volume: 'hermes-evals-trials', subpath: `${ATTEMPT}/home`, target: '/opt/data' },
        { volume: 'hermes-evals-trials', subpath: `${ATTEMPT}/workspace`, target: '/workspace' },
      ],
      disk_cap: { bytes: 2 * 1024 ** 3, files: 50_000 },
      deadline_unix: 1_800_000_370 + SWEEP_MARGIN_S,
    });
    expect(launch.record.container.env_names).toContain('INVOICE_DB_URL');
    expect(launch.record.network).toBe('hermes-evals-trial-1');
  });
});
