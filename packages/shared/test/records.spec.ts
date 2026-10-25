/** Stored records the API reads back (records.ts): the launch record's container block. */
import { describe, expect, it } from 'vitest';
import { LaunchRecordSchema } from '../src/index.js';

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
