/** Stored records the API reads back (records.ts): the launch record's container block, score evidence. */
import { describe, expect, it } from 'vitest';
import { LaunchRecordSchema, ScoreEvidenceSchema } from '../src/index.js';

const record = {
  argv: ['hermes', 'chat', '--api-key', '<attempt-token>'],
  cwd: '/workspace',
  env: { HERMES_HOME: '/opt/data', HOME: '/opt/data', PATH: '/usr/bin' },
  secret_env_names: ['HERMES_EVALS_ATTEMPT_TOKEN'],
  config_path: '/opt/data/config.yaml',
  config_yaml: 'model:\n  default: mock/scripted\n',
  skills: [],
  mcp_servers: [],
  inputs: [],
  limits: { max_turns: 20, run_budget_seconds: 300, deadline_seconds: 370 },
  hermes: { version: '0.22.4', revision: '4d04303'.padEnd(40, '0') },
};

const container = {
  name: 'hermes-evals-run-01ABC',
  image: 'hermes-evals/trial:v0.22.4-4d04303',
  network: 'hermes-evals-trial-0',
  user: '10000:10000',
  read_only_root: true,
  limits: { memory_mib: 1536, cpus: 1, pids: 1024, tmp_mib: 512 },
  mounts: [{ volume: 'hermes-evals-trials', subpath: '01ABC/home', target: '/opt/data' }],
  disk_cap: { bytes: 2 ** 31, files: 50_000 },
  stop_grace_seconds: 10,
  deadline_unix: 1_792_000_000,
  env_names: ['HOME', 'HERMES_EVALS_ATTEMPT_TOKEN'],
};

describe('LaunchRecordSchema', () => {
  it("keeps the runner's slot network and container block", () => {
    const parsed = LaunchRecordSchema.parse({
      ...record,
      network: 'hermes-evals-trial-0',
      container,
    });
    expect(parsed.network).toBe('hermes-evals-trial-0');
    expect(parsed.container).toEqual(container);
  });

  it('reads a record without them, or with a block it cannot read, as having none', () => {
    expect(LaunchRecordSchema.parse(record)).not.toHaveProperty('container');
    const partial = LaunchRecordSchema.parse({ ...record, network: 3, container: { image: 'x' } });
    expect(partial.container).toBeUndefined();
    expect(partial.network).toBeUndefined();
    expect(partial.argv).toEqual(record.argv);
  });
});

describe('ScoreEvidenceSchema', () => {
  const judge = {
    provider: 'nous',
    model: 'openai/gpt-6.1-sol',
    calls: 1,
    tokens: { input: 1200, output: 80, total: 1280 },
    cost_usd: null,
    latency_ms: 2400,
  };

  it('keeps every field the Phase 1 and 2 scorers write', () => {
    for (const evidence of [
      {},
      { event_seqs: [3, 9], artifact_ids: ['art_1'] },
      { error: { message: 'trajectory_match is scored from Phase 3', detail: null } },
      {
        script: {
          argv: ['python3', 'verify/check.py'],
          exit_code: 0,
          timed_out: false,
          duration_ms: 120,
          stdout_line: '{"score": 1}',
          stdout_tail: '',
          stderr_tail: '',
        },
      },
      // The judge block as Phase 1 declared it, with a base URL.
      { judge: { ...judge, base_url: 'http://mock-model:8090/v1', cost_usd: 0.0021 } },
    ]) {
      expect(ScoreEvidenceSchema.parse(evidence)).toEqual(evidence);
    }
  });

  it('records what the Phase 3 scorers found', () => {
    const evidence = {
      event_seqs: [4, 12],
      judge: { ...judge, calls: 2, finish_reason: 'stop' },
      trajectory: { tool: 'mcp__invoice_db__get_invoice', calls: 3, matched_seqs: [4, 12] },
      text: {
        items: [
          { kind: 'phrase', label: '1.5%', found: true },
          { kind: 'phrase', label: '30 days', found: false },
          { kind: 'pattern', label: 'per (month|mo)', found: true },
        ],
        truncated: false,
      },
      json_match: { unit: 'keys', matched: 4, total: 5, mismatches: ['bands[2].net'] },
    };
    expect(ScoreEvidenceSchema.parse(evidence)).toEqual(evidence);
    const moded = { trajectory: { tool: 'read_file', calls: 5, matched_seqs: [], mode: 'subset' } };
    expect(ScoreEvidenceSchema.parse(moded)).toEqual(moded);
  });

  it('refuses malformed scorer detail', () => {
    for (const evidence of [
      { judge: { ...judge, calls: 0 } },
      { judge: { ...judge, cost_usd: -1 } },
      { judge: { ...judge, tokens: { input: 1 } } },
      { judge: { ...judge, model: undefined } },
      { trajectory: { tool: 'read_file', calls: -1, matched_seqs: [] } },
      { trajectory: { tool: 'read_file', calls: 1, matched_seqs: [0] } },
      { trajectory: { tool: 'read_file', calls: 1, matched_seqs: [1], mode: 'exact' } },
      { text: { items: [{ kind: 'word', label: 'a', found: true }], truncated: false } },
      { text: { items: [{ kind: 'phrase', label: 'a', found: 'yes' }], truncated: false } },
      { text: { items: [] } },
      { json_match: { unit: 'fields', matched: 1, total: 1, mismatches: [] } },
      { json_match: { unit: 'keys', matched: 1.5, total: 2, mismatches: [] } },
    ]) {
      expect(ScoreEvidenceSchema.safeParse(evidence).success, JSON.stringify(evidence)).toBe(false);
    }
  });
});
