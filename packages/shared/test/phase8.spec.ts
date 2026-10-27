/**
 * Phase 8's contracts: an answer the model gave without its ```json fence
 * (G5), the judge and its warning when the mock would grade a real model
 * (G2), the samples seed's report with the sample experiment (G3, G4), and
 * the launch record saying what memory off kept out of the home (G9).
 */
import { describe, expect, it } from 'vitest';
import {
  ExtractedAnswerSchema,
  FinalResponseViewSchema,
  HomeMemoryRecordSchema,
  isMockModelRoute,
  JudgeViewSchema,
  LaunchExperimentResultSchema,
  LaunchRecordSchema,
  LaunchRecordViewSchema,
  MOCK_JUDGE_WARNING,
  MOCK_MODEL_NAME_JUDGE_WARNING,
  MOCK_MODEL_BASE_URL,
  MOCK_MODEL_NAME,
  mockJudgeWarning,
  NewExperimentConfigOptionSchema,
  NewExperimentOptionsSchema,
  NewExperimentTaskOptionSchema,
  SAMPLE_EXPERIMENT,
  sampleConfigurationName,
  seedCounts,
  SeedItemSchema,
  SeedReportSchema,
  SystemSetupSchema,
  UNFENCED_ANSWER_NOTE,
  type FinalResponseView,
  type JudgeView,
  type NewExperimentConfigOption,
  type NewExperimentTaskOption,
  type SeedReport,
} from '../src/index.js';

const hash = (c: string) => c.repeat(64);

describe('an unfenced answer (G5)', () => {
  const reply = '  {"total_due": 1520.5}\n';
  const unfenced = {
    status: 'found',
    block_count: 0,
    start: 2,
    end: 23,
    value: { total_due: 1520.5 },
    unfenced: true,
  };

  it('is found with no block, its range the trimmed reply', () => {
    expect(reply.slice(unfenced.start, unfenced.end)).toBe('{"total_due": 1520.5}');
    expect(ExtractedAnswerSchema.parse(unfenced)).toEqual(unfenced);
  });

  it('reads a fenced answer stored before Phase 8 as it was, with no flag', () => {
    const fenced = { status: 'found', block_count: 2, start: 14, end: 32, value: { a: 1 } };
    const parsed = ExtractedAnswerSchema.parse(fenced);
    expect(parsed).toEqual(fenced);
    expect('unfenced' in parsed).toBe(false);
  });

  it('ties the flag to block_count 0, both ways', () => {
    const { unfenced: _, ...noFlag } = unfenced;
    expect(ExtractedAnswerSchema.safeParse(noFlag).success).toBe(false);
    expect(ExtractedAnswerSchema.safeParse({ ...unfenced, block_count: 1 }).success).toBe(false);
    // Fenced answers leave the flag out rather than writing false.
    const fenced = { ...noFlag, block_count: 1 };
    expect(ExtractedAnswerSchema.safeParse({ ...fenced, unfenced: false }).success).toBe(false);
    expect(ExtractedAnswerSchema.safeParse({ ...fenced, block_count: -1 }).success).toBe(false);
  });

  it('keeps missing and invalid as they were', () => {
    expect(ExtractedAnswerSchema.parse({ status: 'missing', block_count: 0 })).toEqual({
      status: 'missing',
      block_count: 0,
    });
    expect(
      ExtractedAnswerSchema.safeParse({
        status: 'invalid',
        block_count: 0,
        start: 0,
        end: 1,
        error: 'x',
        position: null,
      }).success,
    ).toBe(false);
  });

  const view: FinalResponseView = {
    text: reply,
    extracted: { start: 2, end: 23 },
    fence: null,
    extraction: 'found',
    unfenced: true,
    parsed: { total_due: 1520.5 },
    parseError: null,
    reference: { total_due: 1520.5 },
    referenceNote: null,
  };

  it('reaches the inspector with no fence, and says so', () => {
    expect(FinalResponseViewSchema.parse(view)).toEqual(view);
    expect(UNFENCED_ANSWER_NOTE).toBe(
      'Unfenced answer: the reply was one JSON object without a ```json fence.',
    );
  });

  it('is only a found answer without a fence in the view', () => {
    const fenced = { ...view, fence: { start: 0, end: 25 } };
    expect(FinalResponseViewSchema.safeParse(fenced).success).toBe(false);
    expect(FinalResponseViewSchema.parse({ ...fenced, unfenced: false }).unfenced).toBe(false);
    const missing = {
      ...view,
      extracted: null,
      extraction: 'missing',
      parsed: null,
    };
    expect(FinalResponseViewSchema.safeParse(missing).success).toBe(false);
    expect(FinalResponseViewSchema.safeParse({ ...missing, unfenced: false }).success).toBe(true);
    const { unfenced: _, ...withoutFlag } = view;
    expect(FinalResponseViewSchema.safeParse(withoutFlag).success).toBe(false);
  });
});

describe('the mock model as judge (G2)', () => {
  it('knows the mock by its provider and host, not its model name', () => {
    expect(isMockModelRoute({ provider: 'custom', baseUrl: MOCK_MODEL_BASE_URL })).toBe(true);
    expect(isMockModelRoute({ provider: 'custom', baseUrl: 'http://MOCK-MODEL/v1' })).toBe(true);
    expect(isMockModelRoute({ provider: 'custom', baseUrl: 'https://mock-model:9000' })).toBe(true);
    expect(MOCK_MODEL_NAME).toBe('mock/scripted');
    for (const baseUrl of [
      'http://localhost:8090/v1',
      'http://mock-model.example.com/v1',
      'http://my-mock-model:8090/v1',
      'http://user:pw@mock-model:8090/v1',
      'mock-model:8090/v1',
      ' ',
      null,
      undefined,
    ]) {
      expect(isMockModelRoute({ provider: 'custom', baseUrl }), String(baseUrl)).toBe(false);
    }
    // Only `custom` takes a base URL; any other provider is a real model.
    expect(isMockModelRoute({ provider: 'nous', baseUrl: MOCK_MODEL_BASE_URL })).toBe(false);
  });

  it('shows the judge without a base URL or key', () => {
    const judge: JudgeView = {
      provider: 'custom',
      model: MOCK_MODEL_NAME,
      mock: true,
      mockModelName: false,
    };
    expect(JudgeViewSchema.parse(judge)).toEqual(judge);
    expect(
      JudgeViewSchema.parse({ provider: 'nous', model: null, mock: false, mockModelName: false })
        .model,
    ).toBe(null);
    expect(JudgeViewSchema.safeParse({ ...judge, provider: 'gemini' }).success).toBe(false);
    expect(
      JudgeViewSchema.safeParse({ provider: 'nous', mock: false, mockModelName: false }).success,
    ).toBe(false);
    const { mockModelName: _, ...withoutName } = judge;
    expect(JudgeViewSchema.safeParse(withoutName).success).toBe(false);
  });

  it('warns only when the mock would judge a real model on an llm_judge task', () => {
    const mock = { mock: true, mockModelName: false };
    const real = { mockModel: false };
    const scripted = { mockModel: true };
    const judged = { hasLlmJudge: true };
    const plain = { hasLlmJudge: false };
    expect(mockJudgeWarning(mock, [scripted, real], [plain, judged])).toBe(MOCK_JUDGE_WARNING);
    expect(mockJudgeWarning({ mock: false, mockModelName: false }, [real], [judged])).toBe(null);
    expect(mockJudgeWarning(mock, [scripted, scripted], [judged])).toBe(null);
    expect(mockJudgeWarning(mock, [real], [plain])).toBe(null);
    expect(mockJudgeWarning(mock, [], [judged])).toBe(null);
    expect(mockJudgeWarning(mock, [real], [])).toBe(null);
    expect(MOCK_JUDGE_WARNING).toBe(
      'The LLM judge is the mock model, so llm_judge checks will not mean anything on a real model. Set JUDGE_PROVIDER and JUDGE_MODEL in .env.',
    );
  });

  it("warns when the judge's model is the mock's name on a route that is not the mock", () => {
    // JUDGE_PROVIDER=custom and a real JUDGE_BASE_URL in .env, with Compose's default model.
    const named = { mock: false, mockModelName: true };
    const judged = { hasLlmJudge: true };
    // Whatever the configurations: every judge call goes to the judge's route.
    for (const configurations of [[{ mockModel: true }], [{ mockModel: false }], []]) {
      expect(mockJudgeWarning(named, configurations, [{ hasLlmJudge: false }, judged])).toBe(
        MOCK_MODEL_NAME_JUDGE_WARNING,
      );
    }
    expect(mockJudgeWarning(named, [{ mockModel: false }], [{ hasLlmJudge: false }])).toBe(null);
    expect(MOCK_MODEL_NAME_JUDGE_WARNING).toBe(
      "The LLM judge's model is mock/scripted, the mock model's name, but JUDGE_BASE_URL is not the mock model: a real endpoint will fail every llm_judge check that names no model. Set JUDGE_MODEL in .env.",
    );
  });

  const task: NewExperimentTaskOption = {
    key: 'tone',
    version: 1,
    summary: 'Draft the reminder email',
    verificationCount: 2,
    valid: true,
    invalidReason: null,
    hasLlmJudge: true,
  };
  const config: NewExperimentConfigOption = {
    configurationId: 'cfg_1',
    versionId: 'cfgv_1',
    name: 'invoices-v1-baseline',
    version: 1,
    configHash: hash('a'),
    model: 'openai/gpt-6.1-sol',
    provider: 'nous',
    mockModel: false,
    memoryEnabled: false,
    skills: [],
    skillLoading: 'preload',
    mcpServers: [],
    missingSecrets: [],
    estimates: {},
  };

  it('gives New experiment what the warning needs, on tasks, configurations and the options', () => {
    expect(NewExperimentTaskOptionSchema.parse(task)).toEqual(task);
    expect(NewExperimentConfigOptionSchema.parse(config)).toEqual(config);
    const { hasLlmJudge: _, ...taskWithout } = task;
    expect(NewExperimentTaskOptionSchema.safeParse(taskWithout).success).toBe(false);
    const { mockModel: __, ...configWithout } = config;
    expect(NewExperimentConfigOptionSchema.safeParse(configWithout).success).toBe(false);

    const options = {
      suites: [],
      configurations: [config],
      defaults: { repetitions: 3, concurrency: 2 },
      maxConcurrency: 4,
      workerCount: 1,
      priceTable: [],
      judge: { provider: 'custom', model: MOCK_MODEL_NAME, mock: true, mockModelName: false },
    };
    const parsed = NewExperimentOptionsSchema.parse(options);
    expect(parsed).toEqual(options);
    expect(mockJudgeWarning(parsed.judge, parsed.configurations, [task])).toBe(MOCK_JUDGE_WARNING);
    const { judge: ___, ...withoutJudge } = options;
    expect(NewExperimentOptionsSchema.safeParse(withoutJudge).success).toBe(false);
  });

  it('carries the warning in the launch answer', () => {
    const answer = { id: 'exp_01', warnings: [MOCK_JUDGE_WARNING] };
    expect(LaunchExperimentResultSchema.parse(answer)).toEqual(answer);
    expect(LaunchExperimentResultSchema.parse({ id: 'exp_01', warnings: [] }).warnings).toEqual([]);
    expect(LaunchExperimentResultSchema.safeParse({ id: 'exp_01' }).success).toBe(false);
    expect(LaunchExperimentResultSchema.safeParse({ id: 'exp_01', warnings: [''] }).success).toBe(
      false,
    );
  });
});

describe('the samples seed (G3) and the sample experiment (G4)', () => {
  const done: SeedReport = {
    state: 'done',
    startedAt: '2026-10-27T09:00:00.000Z',
    finishedAt: '2026-10-27T09:00:02.400Z',
    items: [
      { kind: 'skill', name: 'invoice-method', outcome: 'created', detail: 'version 1.0.0' },
      {
        kind: 'skill',
        name: 'house-style',
        outcome: 'skipped',
        detail: 'exists with the same content',
      },
      { kind: 'document', name: 'knowledge-v1/handbook.md', outcome: 'created', detail: null },
      {
        kind: 'mcp_server',
        name: 'invoice-db',
        outcome: 'skipped',
        detail: 'a server with this name exists',
      },
      {
        kind: 'configuration',
        name: 'mcp-v1-with-mcp',
        outcome: 'failed',
        detail: 'MCP server vendor-directory is not stored',
      },
    ],
    error: null,
  };

  it('reports what it created, skipped and could not make', () => {
    expect(SeedReportSchema.parse(done)).toEqual(done);
    expect(seedCounts(done)).toEqual({ created: 2, skipped: 2, failed: 1 });
    expect(seedCounts({ items: [] })).toEqual({ created: 0, skipped: 0, failed: 0 });
  });

  it('says why an item was skipped or failed', () => {
    const skipped = { kind: 'skill', name: 'house-style', outcome: 'skipped', detail: null };
    expect(SeedItemSchema.safeParse(skipped).success).toBe(false);
    expect(SeedItemSchema.safeParse({ ...skipped, outcome: 'failed' }).success).toBe(false);
    expect(SeedItemSchema.safeParse({ ...skipped, outcome: 'created' }).success).toBe(true);
    expect(SeedItemSchema.safeParse({ ...skipped, kind: 'suite', detail: 'x' }).success).toBe(
      false,
    );
    expect(SeedItemSchema.safeParse({ ...skipped, name: '', detail: 'x' }).success).toBe(false);
  });

  it('keeps each state to its own times and error', () => {
    const off = { state: 'off', startedAt: null, finishedAt: null, items: [], error: null };
    const running = { ...done, state: 'running', finishedAt: null };
    const failed = { ...done, state: 'failed', error: '/opt/samples is not mounted' };
    for (const report of [off, running, failed]) {
      expect(SeedReportSchema.parse(report)).toEqual(report);
    }
    const bad = [
      { ...off, startedAt: done.startedAt },
      { ...off, items: done.items },
      { ...running, finishedAt: done.finishedAt },
      { ...running, startedAt: null },
      { ...done, finishedAt: null },
      { ...done, error: 'boom' },
      { ...failed, error: null },
      { ...failed, error: '' },
    ];
    for (const report of bad) {
      expect(SeedReportSchema.safeParse(report).success, JSON.stringify(report)).toBe(false);
    }
  });

  it('answers GET /system/setup with the judge and the seed', () => {
    const setup = {
      judge: { provider: 'custom', model: MOCK_MODEL_NAME, mock: true, mockModelName: false },
      seed: done,
    };
    expect(SystemSetupSchema.parse(setup)).toEqual(setup);
    expect(SystemSetupSchema.safeParse({ judge: setup.judge }).success).toBe(false);
  });

  it('names the recommended configurations and the sample experiment', () => {
    expect(sampleConfigurationName('memory-v1', 'memory-on', 'real')).toBe('memory-v1-memory-on');
    expect(sampleConfigurationName('memory-v1', 'memory-on', 'mock')).toBe(
      'memory-v1-memory-on-mock',
    );
    expect(SAMPLE_EXPERIMENT).toEqual({
      suite: 'invoices-v1',
      baseline: 'invoices-v1-baseline-mock',
      candidate: 'invoices-v1-with-skill-mock',
      repetitions: 2,
      name: 'Sample: invoices-v1, baseline against with-skill (mock model)',
    });
  });
});

describe('memory off keeps memory out of the home (G9)', () => {
  const record = {
    argv: ['hermes', 'chat'],
    cwd: '/workspace',
    env: { HERMES_HOME: '/opt/data', HOME: '/opt/data', PATH: '/usr/bin' },
    secret_env_names: [],
    config_path: '/opt/data/config.yaml',
    config_yaml: 'model:\n  default: mock/scripted\n',
    skills: [],
    mcp_servers: [],
    inputs: [],
    limits: { max_turns: 20, run_budget_seconds: 300, deadline_seconds: 370 },
    hermes: { version: '0.22.4', revision: '4d04303'.padEnd(40, '0') },
  };
  const off = {
    memory_enabled: false,
    seeds_skipped: ['memories/MEMORY.md', 'memories/USER.md'],
    memories_collected: false,
  };
  const on = { memory_enabled: true, seeds_skipped: [], memories_collected: true };

  it('records the setting, the seeds it left out and whether home/memories was collected', () => {
    for (const home of [off, on, { ...off, seeds_skipped: [] }]) {
      expect(HomeMemoryRecordSchema.parse(home)).toEqual(home);
      expect(LaunchRecordSchema.parse({ ...record, home_memory: home }).home_memory).toEqual(home);
    }
  });

  it('collects home/memories exactly when memory is on, and skips no seed then', () => {
    for (const home of [
      { ...off, memories_collected: true },
      { ...on, memories_collected: false },
      { ...on, seeds_skipped: ['memories/USER.md'] },
    ]) {
      expect(HomeMemoryRecordSchema.safeParse(home).success, JSON.stringify(home)).toBe(false);
    }
  });

  it('reads a record from before Phase 8, or one it cannot read, as saying nothing', () => {
    expect(LaunchRecordSchema.parse(record)).not.toHaveProperty('home_memory');
    const odd = LaunchRecordSchema.parse({
      ...record,
      home_memory: { ...off, memories_collected: true },
    });
    expect(odd.home_memory).toBeUndefined();
    expect(odd.argv).toEqual(record.argv);
  });

  it('shows it in the inspector, null for older records', () => {
    const homeMemory = {
      memoryEnabled: false,
      seedsSkipped: ['memories/USER.md'],
      memoriesCollected: false,
    };
    const shape = LaunchRecordViewSchema.shape.homeMemory;
    expect(shape.parse(homeMemory)).toEqual(homeMemory);
    expect(shape.parse(null)).toBe(null);
    expect(shape.safeParse(undefined).success).toBe(false);
  });
});
