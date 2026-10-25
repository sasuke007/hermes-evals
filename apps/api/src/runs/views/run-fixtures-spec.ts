/**
 * The constants, verification lists and launch record seedRunStates writes
 * (runs-seed-spec.ts), shared by the specs that check what they become.
 *
 * Test-only: the name ends in `spec.ts` so the build leaves it out, but not
 * in `.spec.ts`, so vitest does not run it as a test file.
 */
import type {
  ExecutionErrorCategory,
  LaunchRecord,
  ScoreEvidence,
  ScorerType,
  ScoreStatus,
  Tokens,
  VerificationEntry,
} from '@hermes-evals/shared';
import { HERMES_REVISION, sha } from '../../../test/support/seed.js';

export const INVOICES_CSV = 'invoice_no,amount\nINV-1,10.00\nINV-2,20.00\n';
export const SUMMARY_CSV = 'vendor,outstanding\nBrightline,6215.00\nKestrel,1486.65\n';
export const REPORT_HTML = '<script>alert(1)</script>';
export const MOCK_BASE_URL = 'http://mock-model:8090/v1';
export const TRIAL_IMAGE = 'hermes-evals/trial:v0.22.4-4d04303';
/** What argv held for the token in a careless runner; it must never be shown. */
export const LEAKED_TOKEN = 'tok_must_never_be_shown';

export const DUP_VERIFICATION: VerificationEntry[] = [
  { key: 'answer', type: 'json_match', primary: true, params: { unordered: true } },
  {
    key: 'reads_fixture',
    type: 'trajectory_match',
    primary: false,
    params: { tool: 'read_file', min_calls: 1 },
  },
  { key: 'check', type: 'verifier_script', primary: false, params: { script: 'check.py' } },
];
export const DUP_YAML = 'summary: Find invoices billed twice\nanswer:\n  path: duplicates\n';
export const TOTAL_VERIFICATION: VerificationEntry[] = [
  {
    key: 'total',
    type: 'numeric_tolerance',
    primary: true,
    params: { path: 'total_due', abs: 0.01 },
  },
  { key: 'method', type: 'llm_judge', primary: false, params: { rubric: 'rubric.md' } },
];

export const tokens = (input: number, output: number): Tokens => ({
  input,
  output,
  total: input + output,
  cache_read: 0,
  cache_write: 0,
});

/**
 * A launch record as the runner writes it: the shared fields plus its
 * `container` block (execution/attempt/launch.ts), which the sink stores
 * as it is.
 */
export function launchRecord(fixtureSha: string, apiKey = '<attempt token>'): LaunchRecord {
  const record = {
    argv: [
      '/opt/hermes/.venv/bin/hermes',
      'chat',
      '--query-file',
      '/opt/data/task.txt',
      '--oneshot',
      '--format',
      'stream-json',
      '--provider',
      'custom',
      '-m',
      'mock/scripted',
      '--base-url',
      'http://egress:8080/v1',
      '--api-key',
      apiKey,
      '-t',
      'file,terminal,invoice-db',
      '--max-turns',
      '20',
      '--yolo',
      '--in',
      '/workspace',
    ],
    cwd: '/workspace',
    env: { HERMES_HOME: '/opt/data', HOME: '/opt/data', PATH: '/opt/hermes/.venv/bin:/usr/bin' },
    secret_env_names: ['INVOICE_DB_URL'],
    config_path: '/opt/data/config.yaml',
    config_yaml:
      'model:\n  default: mock/scripted\n  provider: custom\n  base_url: http://egress:8080/v1\n' +
      'mcp_servers:\n  invoice-db:\n    command: invoice-db-mcp\n    env:\n      INVOICE_DB_URL: ${INVOICE_DB_URL}\n' +
      'agent:\n  max_turns: 20\n  run_budget_seconds: 120\n',
    skills: [
      { skill_id: 'skill_1', name: 'invoice-method', version: '1.0.0', content_hash: sha('skill') },
    ],
    mcp_servers: [
      {
        mcp_server_version_id: 'mcpv_1',
        name: 'invoice-db',
        version: 1,
        transport: 'stdio',
        definition_hash: sha('mcp'),
      },
    ],
    inputs: [{ path: 'invoices.csv', sha256: fixtureSha, source: 'fixture' }],
    limits: { max_turns: 20, run_budget_seconds: 120, deadline_seconds: 190 },
    hermes: { version: '0.22.4', revision: HERMES_REVISION },
    container: {
      name: 'hermes-evals-run-01J',
      image: TRIAL_IMAGE,
      network: 'hermes-evals-trial-1',
      user: '10000:10000',
      read_only_root: true,
      limits: { memory_mib: 1536, cpus: 1, pids: 1024, tmp_mib: 512 },
      mounts: [
        { volume: 'hermes-evals-trials', subpath: 'att_1/home', target: '/opt/data' },
        { volume: 'hermes-evals-trials', subpath: 'att_1/workspace', target: '/workspace' },
      ],
      disk_cap: { bytes: 2 * 1024 ** 3, files: 50_000 },
      stop_grace_seconds: 10,
      deadline_unix: 1_792_856_300,
      env_names: ['HERMES_EVALS_ATTEMPT_TOKEN', 'HTTPS_PROXY', 'INVOICE_DB_URL'],
    },
  };
  return record as LaunchRecord;
}

export interface ScoreSeed {
  key: string;
  type: ScorerType;
  status: ScoreStatus;
  primary?: boolean;
  score?: number | null;
  comment: string;
  expected?: unknown;
  observed?: unknown;
  evidence?: ScoreEvidence;
}

export interface AttemptEnd {
  status: 'executed' | 'execution_error' | 'cancelled';
  category?: ExecutionErrorCategory;
  message?: string;
  exitCode?: number | null;
  durationMs?: number;
  finalText?: string;
  tokens?: Tokens;
  costUsd?: number;
  stderrTail?: string;
}

export type RunCell = `${'dup_invoices' | 'total_due'}/${'baseline' | 'with-skill'}/${number}`;
