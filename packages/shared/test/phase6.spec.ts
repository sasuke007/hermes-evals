/**
 * The Phase 6 platform additions in the contracts (plan 18.2): home seeds
 * and their expected home (P1, P2), memory files as artifacts with a root
 * (P2), the background review intervals in the launch record (P3), the
 * skill loading mode (P5), and the unset MCP variables New experiment shows
 * and launch refuses (Phase 5 decision #13).
 */
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_ORIGINS,
  ARTIFACT_ROOTS,
  ArtifactViewSchema,
  CONFIG_FIELDS,
  ConfigurationDraftSchema,
  ConfigurationFormOptionsSchema,
  ConfigurationInputSchema,
  FileCheckParamsSchema,
  HOME_SEED_PATHS,
  homeSeedTarget,
  isHomeSeedPath,
  LaunchRecordSchema,
  LaunchRecordViewSchema,
  LoadIssueSchema,
  MEMORY_CHAR_LIMITS,
  MEMORY_ENTRY_DELIMITER,
  MissingMcpSecretSchema,
  MissingSecretsConflictSchema,
  MISSING_SECRETS_HINT,
  missingSecretsConflictMessage,
  missingSecretsReason,
  missingSecretText,
  NEW_CONFIGURATION_DEFAULTS,
  NewExperimentConfigOptionSchema,
  SelfCheckSchema,
  SKILL_LOADING_LABELS,
  SKILL_LOADING_MODES,
  SKILL_LOADING_NEEDS_SKILLS,
  SKILL_LOADING_OPTIONS,
  TASK_FILE_KINDS,
  TaskYamlSchema,
  type ArtifactView,
  type ConfigurationInput,
  type LaunchRecordView,
  type MissingMcpSecret,
} from '../src/index.js';

const hash = (c: string) => c.repeat(64);

const TASK = {
  summary: 'Remember the reporting currency',
  limits: { max_turns: 10, run_budget_seconds: 120, toolsets_needed: ['memory'] },
  answer: { format: 'fenced_json' },
  verification: [
    {
      key: 'saved',
      type: 'file_check',
      primary: true,
      params: { root: 'home', path: 'memories/USER.md', contains: ['EUR'] },
    },
  ],
};

/** Issue paths of a failed parse, joined with dots. */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  expect(result.success).toBe(false);
  return result.error!.issues.map((i) => i.path.join('.'));
}

describe('vocabularies (migration 0008 widens their CHECKs)', () => {
  it('adds the two task file kinds, the home seed origins, the roots and the loading modes', () => {
    expect(TASK_FILE_KINDS).toEqual([
      'fixture',
      'verifier',
      'rubric',
      'expected',
      'home_seed',
      'expected_home',
    ]);
    expect(ARTIFACT_ORIGINS).toContain('home_seed_unchanged');
    expect(ARTIFACT_ORIGINS).toContain('home_seed_modified');
    expect(ARTIFACT_ORIGINS.at(-1)).toBe('agent');
    expect(ARTIFACT_ROOTS).toEqual(['workspace', 'home']);
    expect(SKILL_LOADING_MODES).toEqual(['preload', 'on_demand']);
  });
});

describe('home seeds (P1)', () => {
  it('accepts exactly the two memory files and maps each to its place in the home', () => {
    expect(HOME_SEED_PATHS.map(homeSeedTarget)).toEqual(['memories/MEMORY.md', 'memories/USER.md']);
    for (const path of HOME_SEED_PATHS) expect(isHomeSeedPath(path)).toBe(true);
    for (const path of ['home/memories/NOTES.md', 'home/config.yaml', 'memories/MEMORY.md']) {
      expect(isHomeSeedPath(path)).toBe(false);
    }
  });

  it("keeps Hermes's budgets and entry delimiter", () => {
    expect(MEMORY_CHAR_LIMITS).toEqual({ 'MEMORY.md': 2200, 'USER.md': 1375 });
    expect(MEMORY_ENTRY_DELIMITER).toBe('\n§\n');
  });

  it('has load issue codes for a stray home path and a malformed seed', () => {
    for (const [severity, code] of [
      ['error', 'home_path_invalid'],
      ['warning', 'home_seed_format'],
    ] as const) {
      const issue = { severity, code, path: 'home/memories/MEMORY.md', message: 'x' };
      expect(LoadIssueSchema.parse(issue)).toEqual(issue);
    }
  });
});

describe('file_check root (P2)', () => {
  it('defaults to the workspace and reads the home under memories/', () => {
    expect(FileCheckParamsSchema.parse({ path: 'summary.csv' }).root).toBe('workspace');
    expect(FileCheckParamsSchema.parse({ root: 'home', path: 'memories/USER.md' })).toEqual({
      root: 'home',
      path: 'memories/USER.md',
      must_exist: true,
    });
  });

  it('refuses another root, and a home path outside memories/', () => {
    expect(issuePaths(FileCheckParamsSchema.safeParse({ root: 'trial', path: 'a' }))).toEqual([
      'root',
    ]);
    for (const path of ['config.yaml', 'skills/x/SKILL.md', 'memories']) {
      expect(issuePaths(FileCheckParamsSchema.safeParse({ root: 'home', path }))).toEqual(['path']);
    }
    // The workspace has no such rule.
    expect(FileCheckParamsSchema.safeParse({ path: 'memories/USER.md' }).success).toBe(true);
  });
});

describe('self_check.expected_home (P2)', () => {
  it('accepts an expected home alone or beside an expected workspace', () => {
    const alone = TaskYamlSchema.parse({ ...TASK, self_check: { expected_home: 'expected_home' } });
    expect(alone.self_check).toEqual({ expected_home: 'expected_home' });
    const both = TaskYamlSchema.parse({
      ...TASK,
      self_check: {
        expected_workspace: 'expected',
        expected_home: 'remembered',
        negative_control: true,
      },
    });
    expect(both.self_check?.expected_home).toBe('remembered');
    expect(
      TaskYamlSchema.safeParse({
        ...TASK,
        self_check: { expected_home: 'expected_home', negative_control: true },
      }).success,
    ).toBe(true);
  });

  it('refuses a negative control with neither folder, a shared folder and the seeds folder', () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ negative_control: true }, 'self_check.negative_control'],
      [{ expected_workspace: 'expected', expected_home: 'expected' }, 'self_check.expected_home'],
      [{ expected_home: 'home' }, 'self_check.expected_home'],
      [{ expected_home: './home/memories' }, 'self_check.expected_home'],
      [{ expected_home: '../elsewhere' }, 'self_check.expected_home'],
    ];
    for (const [selfCheck, path] of bad) {
      expect(issuePaths(TaskYamlSchema.safeParse({ ...TASK, self_check: selfCheck }))).toEqual([
        path,
      ]);
    }
    // A folder whose name only starts with "home" is its own folder.
    expect(
      TaskYamlSchema.safeParse({ ...TASK, self_check: { expected_home: 'home_expected' } }).success,
    ).toBe(true);
  });

  it('records home checks and the expected home files in the self-check', () => {
    const check = {
      status: 'passed',
      ran_at: '2026-10-26T09:00:00.000Z',
      duration_ms: 40,
      results: [
        { key: 'saved', type: 'file_check', mode: 'home', status: 'passed', score: 1, comment: '' },
        {
          key: 'saved',
          type: 'file_check',
          mode: 'home',
          expect: 'fail',
          status: 'failed',
          score: 0,
          comment: 'memories/USER.md does not contain "EUR"',
        },
      ],
      expected_home: [{ path: 'memories/USER.md', sha256: hash('a') }],
    };
    expect(SelfCheckSchema.parse(check)).toEqual(check);
  });
});

const RECORD = {
  argv: ['hermes', 'chat', '--api-key', '<attempt-token>'],
  cwd: '/workspace',
  env: { HERMES_HOME: '/opt/data', HOME: '/opt/data', PATH: '/usr/bin' },
  secret_env_names: [],
  config_path: '/opt/data/config.yaml',
  config_yaml: 'memory:\n  nudge_interval: 0\nskills:\n  creation_nudge_interval: 0\n',
  skills: [],
  mcp_servers: [],
  inputs: [{ path: 'invoices.csv', sha256: hash('b'), source: 'fixture' }],
  limits: { max_turns: 20, run_budget_seconds: 300, deadline_seconds: 370 },
  hermes: { version: '0.22.4', revision: '4d04303'.padEnd(40, '0') },
};

describe('the stored launch record (P1, P3, P5)', () => {
  it('lists home seeds as inputs and keeps the loading mode and review intervals', () => {
    const record = {
      ...RECORD,
      inputs: [
        ...RECORD.inputs,
        { path: 'memories/MEMORY.md', sha256: hash('c'), source: 'home_seed' },
      ],
      skill_loading: 'on_demand',
      background_review: { memory_nudge_interval: 0, skill_creation_nudge_interval: 0 },
    };
    expect(LaunchRecordSchema.parse(record)).toEqual(record);
  });

  it('reads a record from before Phase 6 without them, and refuses an unknown mode', () => {
    const old = LaunchRecordSchema.parse(RECORD);
    expect(old.skill_loading).toBeUndefined();
    expect(old.background_review).toBeUndefined();
    expect(LaunchRecordSchema.safeParse({ ...RECORD, skill_loading: 'lazy' }).success).toBe(false);
  });
});

const artifact = (over: Partial<ArtifactView>): ArtifactView => ({
  id: 'art_01',
  root: 'workspace',
  path: 'workspace/summary.csv',
  origin: 'agent',
  sizeBytes: 120,
  sha256: hash('d'),
  skippedReason: null,
  preview: null,
  ...over,
});

describe('artifacts with a root (P2)', () => {
  it('accepts memory files under home/ with a seed origin or as the agent’s own', () => {
    for (const origin of ['home_seed_unchanged', 'home_seed_modified', 'agent'] as const) {
      const memory = artifact({ root: 'home', path: 'home/memories/MEMORY.md', origin });
      expect(ArtifactViewSchema.parse(memory)).toEqual(memory);
    }
    expect(ArtifactViewSchema.safeParse(artifact({})).success).toBe(true);
  });

  it('refuses a path outside its root and an origin of the other root', () => {
    const bad: [Partial<ArtifactView>, string][] = [
      [{ root: 'home', path: 'workspace/memories/MEMORY.md' }, 'path'],
      [{ path: 'home/memories/MEMORY.md' }, 'path'],
      [{ origin: 'home_seed_unchanged' }, 'origin'],
      [{ root: 'home', path: 'home/memories/USER.md', origin: 'fixture_modified' }, 'origin'],
    ];
    for (const [over, path] of bad) {
      expect(issuePaths(ArtifactViewSchema.safeParse(artifact(over)))).toEqual([path]);
    }
  });
});

const LAUNCH_VIEW: LaunchRecordView = {
  container: {
    image: 'hermes-evals/trial:v0.22.4-4d04303',
    digest: 'sha256:7a6920…',
    hermes: 'hermes-agent v0.22.4 @ 4d04303',
    network: 'hermes-evals-trial-1',
    user: '10000',
    imageFilesystem: 'read-only',
    limits: { memory: '1.5 GB', cpus: 1, processes: 1024, tmp: '512 MB' },
    mounts: [{ name: 'home', target: '/opt/data' }],
    diskCap: { bytes: 2 * 1024 ** 3, files: 50000 },
    worker: { name: 'worker-1', startedAt: '2026-10-26T10:20:15', exitCode: 0 },
    skills: [{ name: 'invoice-method', version: '1.0.0', contentHash: hash('e') }],
    skillLoading: 'on_demand',
    mcpServers: [],
  },
  command: 'hermes chat … -t file,terminal,skills',
  commandNote: null,
  configPath: '/opt/data/config.yaml',
  configYaml: RECORD.config_yaml,
  configNote: null,
  homeSeeds: [{ path: 'memories/USER.md', sha256: hash('f') }],
  backgroundReview: { memoryNudgeInterval: 0, skillCreationNudgeInterval: 0 },
  homeMemory: { memoryEnabled: true, seedsSkipped: [], memoriesCollected: true },
};

describe('the launch record view (P1, P3, P5)', () => {
  it('shows the home seeds, the loading mode and the review intervals', () => {
    expect(LaunchRecordViewSchema.parse(LAUNCH_VIEW)).toEqual(LAUNCH_VIEW);
    const older = { ...LAUNCH_VIEW, homeSeeds: [], backgroundReview: null, homeMemory: null };
    expect(LaunchRecordViewSchema.parse(older)).toEqual(older);
    const { skillLoading: _, ...noMode } = LAUNCH_VIEW.container;
    expect(
      issuePaths(LaunchRecordViewSchema.safeParse({ ...LAUNCH_VIEW, container: noMode })),
    ).toEqual(['container.skillLoading']);
  });
});

const CONFIG: ConfigurationInput = {
  name: 'skills-on-demand',
  model: 'mock/scripted',
  provider: 'custom',
  baseUrl: 'http://mock-model:8090/v1',
  toolsets: ['file', 'terminal'],
  memoryEnabled: false,
  skillIds: ['skill_01JAX9C41E07'],
  skillLoading: 'on_demand',
  documentIds: [],
  mcpServerVersionIds: [],
  maxTurns: 20,
  timeBudgetS: 300,
  duplicatedFromVersionId: null,
};

describe('skill loading (P5)', () => {
  it('is a diff row right after skills, labelled for every view', () => {
    expect(CONFIG_FIELDS.indexOf('skill_loading')).toBe(CONFIG_FIELDS.indexOf('skills') + 1);
    expect(SKILL_LOADING_LABELS).toEqual({ preload: 'preload', on_demand: 'on demand' });
    expect(SKILL_LOADING_OPTIONS.map((o) => o.id)).toEqual([...SKILL_LOADING_MODES]);
    expect(NEW_CONFIGURATION_DEFAULTS.skillLoading).toBe('preload');
  });

  it('saves on demand with skills, and defaults a body without it to preload', () => {
    expect(ConfigurationInputSchema.parse(CONFIG)).toEqual(CONFIG);
    const { skillLoading: _, ...older } = CONFIG;
    expect(ConfigurationInputSchema.parse(older).skillLoading).toBe('preload');
    const draft = ConfigurationDraftSchema.parse({
      mode: 'new',
      source: null,
      values: { ...older, name: '' },
      createsNewVersion: false,
      nextVersion: null,
      experimentsKeepingVersion: [],
    });
    expect(draft.values.skillLoading).toBe('preload');
  });

  it('refuses on demand without skills with the 400 message, and an unknown mode', () => {
    const empty = ConfigurationInputSchema.safeParse({ ...CONFIG, skillIds: [] });
    expect(issuePaths(empty)).toEqual(['skillLoading']);
    expect(empty.error!.issues[0]!.message).toBe(SKILL_LOADING_NEEDS_SKILLS);
    expect(SKILL_LOADING_NEEDS_SKILLS).toBe(
      'Skill loading applies only when the configuration has skills',
    );
    expect(
      issuePaths(ConfigurationInputSchema.safeParse({ ...CONFIG, skillLoading: 'lazy' })),
    ).toEqual(['skillLoading']);
    // preload without skills is what every skill-less configuration is.
    expect(
      ConfigurationInputSchema.safeParse({ ...CONFIG, skillIds: [], skillLoading: 'preload' })
        .success,
    ).toBe(true);
  });

  it('offers both modes in the form options', () => {
    const options = {
      models: [],
      providers: [],
      toolsets: [{ name: 'skills', defaultOn: false }],
      skills: [],
      documents: [],
      mcpServers: [],
      skillLoading: SKILL_LOADING_OPTIONS,
    };
    expect(ConfigurationFormOptionsSchema.parse(options)).toEqual(options);
    const { skillLoading: _, ...without } = options;
    expect(ConfigurationFormOptionsSchema.safeParse(without).success).toBe(false);
  });
});

const TOKEN: MissingMcpSecret = {
  server: 'vendor-directory',
  name: 'VENDOR_DIRECTORY_TOKEN',
  transport: 'http',
};
const DB_URL: MissingMcpSecret = {
  server: 'invoice-db',
  name: 'INVOICE_DB_URL',
  transport: 'stdio',
};

describe('unset MCP variables (Phase 5 decision #13)', () => {
  it('names each variable with its server and who reads it', () => {
    expect(missingSecretText(TOKEN)).toBe(
      'VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress)',
    );
    expect(missingSecretText(DB_URL)).toBe('INVOICE_DB_URL (invoice-db, read by the worker)');
    expect(missingSecretsReason('with-mcp', [])).toBe('');
    expect(missingSecretsReason('with-mcp', [TOKEN])).toBe(
      'with-mcp: VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress) is not set',
    );
    expect(
      missingSecretsReason('with-mcp', [DB_URL, TOKEN, { ...TOKEN, name: 'VENDOR_REGION' }]),
    ).toBe(
      'with-mcp: INVOICE_DB_URL (invoice-db, read by the worker), VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress) and VENDOR_REGION (vendor-directory, added by egress) are not set',
    );
  });

  it('carries them on each configuration option, names only', () => {
    const option = {
      configurationId: 'cfg_01',
      versionId: 'cfgv_01',
      name: 'with-mcp',
      version: 1,
      configHash: hash('a'),
      model: 'mock/scripted',
      provider: 'custom',
      mockModel: true,
      memoryEnabled: false,
      skills: [],
      skillLoading: 'preload',
      mcpServers: ['invoice-db (stdio)', 'vendor-directory (http)'],
      missingSecrets: [DB_URL, TOKEN],
      estimates: {},
    };
    expect(NewExperimentConfigOptionSchema.parse(option)).toEqual(option);
    expect(MissingMcpSecretSchema.safeParse({ ...TOKEN, name: 'vendor token' }).success).toBe(
      false,
    );
    const { missingSecrets: _, ...without } = option;
    expect(NewExperimentConfigOptionSchema.safeParse(without).success).toBe(false);
  });

  it('shapes the launch 409: one issue per variable, on the field that chose the configuration', () => {
    const message = missingSecretsConflictMessage([
      { configuration: 'baseline', missing: [] },
      { configuration: 'with-mcp', missing: [TOKEN] },
    ]);
    expect(message).toBe(`${missingSecretsReason('with-mcp', [TOKEN])}. ${MISSING_SECRETS_HINT}`);
    expect(
      missingSecretsConflictMessage([
        { configuration: 'a', missing: [DB_URL] },
        { configuration: 'b', missing: [TOKEN] },
      ]),
    ).toBe(
      `a: INVOICE_DB_URL (invoice-db, read by the worker) is not set; b: VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress) is not set. ${MISSING_SECRETS_HINT}`,
    );
    const body = {
      statusCode: 409,
      message,
      issues: [{ path: 'candidateVersionIds.0', message: missingSecretText(TOKEN) }],
    };
    expect(MissingSecretsConflictSchema.parse(body)).toEqual(body);
    const bad = [
      { ...body, statusCode: 400 },
      { ...body, issues: [] },
      { ...body, issues: [{ path: 'cfgv_01', message: 'x' }] },
      { ...body, issues: undefined },
    ];
    for (const value of bad)
      expect(MissingSecretsConflictSchema.safeParse(value).success).toBe(false);
    expect(
      MissingSecretsConflictSchema.safeParse({
        ...body,
        issues: [{ path: 'baselineVersionId', message: missingSecretText(DB_URL) }],
      }).success,
    ).toBe(true);
  });
});
