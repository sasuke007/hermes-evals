/**
 * The samples a fresh clone starts with (Phase 8 G3, G4), as New experiment's options show
 * them under `samples-seeded`: invoices-v1's recommended configurations on the scripted mock
 * model, which "Run a sample experiment" launches against each other. The fixture world's
 * other configurations (baseline, with-skill, with-mcp) do not exist yet on a fresh clone.
 */
import {
  MOCK_MODEL_NAME,
  SAMPLE_EXPERIMENT,
  type NewExperimentConfigOption,
  type PerRunEstimate,
} from '@hermes-evals/shared';
import { sha, ulid } from './suites';

/** The mock answers in a few seconds and costs nothing; nothing has run on it yet. */
const MOCK_ESTIMATE: PerRunEstimate = {
  seconds: 8,
  costUsd: 0,
  tokens: 15000,
  basis: 'budget',
  pastRuns: 0,
};

/** invoices-v1's two mock arms as GET /experiments/new-options offers them. */
export function sampleConfigOptions(suiteIds: readonly string[]): NewExperimentConfigOption[] {
  const arms = [
    { name: SAMPLE_EXPERIMENT.baseline, skills: [] as string[] },
    { name: SAMPLE_EXPERIMENT.candidate, skills: ['invoice-method@1.0.0'] },
  ];
  return arms.map(({ name, skills }) => ({
    configurationId: ulid('cfg', name),
    versionId: ulid('cfv', name),
    name,
    version: 1,
    configHash: sha(`config-${name}`),
    model: MOCK_MODEL_NAME,
    provider: 'custom',
    mockModel: true,
    memoryEnabled: false,
    skills,
    skillLoading: 'preload',
    mcpServers: [],
    missingSecrets: [],
    estimates: Object.fromEntries(suiteIds.map((id) => [id, { ...MOCK_ESTIMATE }])),
  }));
}
