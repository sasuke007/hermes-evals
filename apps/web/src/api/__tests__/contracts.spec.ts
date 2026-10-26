/**
 * Every fixture the data layer serves (suites, resources, configurations,
 * system, providers, experiments and runs), in every scenario, parses with
 * the shared contract the API answers with, and every request body the pages
 * build parses with the shared request schema. A fixture and its contract
 * therefore cannot drift: a field renamed on one side fails here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import {
  BulkRescoreResultSchema,
  BulkRunActionInputSchema,
  BulkRunActionResultSchema,
  COMPARISON_FILTERS,
  ComparisonViewSchema,
  ConfigDiffSchema,
  ConfigurationDetailSchema,
  ConfigurationDraftSchema,
  ConfigurationFormOptionsSchema,
  ConfigurationInputSchema,
  ConfigurationListRowSchema,
  ConfigurationSaveResultSchema,
  DocumentRowSchema,
  ExperimentActionResultSchema,
  ExperimentDetailSchema,
  ExperimentEstimateViewSchema,
  ExperimentEventSchema,
  ExperimentListRowSchema,
  LaunchExperimentInputSchema,
  LaunchExperimentResultSchema,
  McpServerInputSchema,
  McpServerRowSchema,
  McpTestViewSchema,
  NewExperimentDraftSchema,
  NewExperimentOptionsSchema,
  NousLoginSchema,
  ProvidersResponseSchema,
  ResourceCountsSchema,
  ResumeExperimentInputSchema,
  RUN_SORT_KEYS,
  RescoreRunResultSchema,
  RunActionResultSchema,
  RunDetailSchema,
  RunEventsPageSchema,
  RunListResultSchema,
  SandboxStatusSchema,
  SecretRowSchema,
  SkillDetailSchema,
  SkillFileContentSchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
  SuiteDetailSchema,
  SuiteHistoryEntrySchema,
  SuiteListRowSchema,
  SuiteReloadResultSchema,
  SystemEventSchema,
  SystemSummarySchema,
  TablePreviewSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskVersionEntrySchema,
  type ExperimentDetail,
  type ExperimentEvent,
  type ExperimentListRow,
  type LaunchExperimentInput,
  type NewExperimentOptions,
  type NewExperimentSuiteOption,
  type RunFilters,
  type RunListResult,
  type RunRow,
} from '@hermes-evals/shared';
import { ApiError } from '@/api/client';
import {
  diffConfigurations,
  getConfiguration,
  getConfigurationDraft,
  getConfigurationFormOptions,
  listConfigurations,
  saveConfiguration,
} from '@/api/configurations';
import {
  cancelExperiment,
  duplicateExperiment,
  estimateExperiment,
  getComparison,
  getExperiment,
  getNewExperimentOptions,
  launchExperiment,
  listExperiments,
  pauseExperiment,
  resumeExperiment,
  retryFailedRuns,
} from '@/api/experiments';
import {
  cancelNousLogin,
  getNousLogin,
  listProviders,
  LOGIN_OUTCOMES,
  logoutNous,
  simulateNousLogin,
  startNousLogin,
} from '@/api/providers';
import {
  checkSecrets,
  confirmSkillUpload,
  getResourceCounts,
  getSkill,
  getSkillFile,
  listDocuments,
  listMcpServers,
  listSecrets,
  listSkills,
  saveMcpServer,
  testMcpServer,
  uploadDocument,
  validateSkillUpload,
} from '@/api/resources';
import {
  cancelRun,
  getArtifactPreview,
  getRun,
  listRunEvents,
  listRuns,
  rescoreRun,
  rescoreRuns,
  retryRun,
  retryRuns,
} from '@/api/runs';
import { rescoreRunFixture } from '@/fixtures/runs';
import {
  getFixturePreview,
  getSuite,
  getSuiteHistory,
  getTask,
  getTaskDiff,
  getTaskHistory,
  listSuites,
  reloadSuites,
} from '@/api/suites';
import { getSandboxStatus, getSystemSummary } from '@/api/system';
import {
  MCP_INVOICE_DB_INPUT,
  MCP_VENDOR_API_INPUT,
  SKILL_INVOICE_METHOD_110_ID,
} from '@/fixtures/resources';
import { SCENARIOS } from '@/fixtures/scenarios';
import { MISSING_FOLDERS } from '@/fixtures/suites-authoring';
import { resetSystemFixtures } from '@/fixtures/system';
import { setScenario } from './scenario';

/** Every scenario that serves data (`loading` never resolves, `error` always rejects), and none. */
const SCENARIO_NAMES: (string | null)[] = [
  null,
  ...SCENARIOS.map((s) => s.name).filter((n) => n !== 'loading' && n !== 'error'),
];

function use(name: string | null): void {
  setScenario(name);
  resetSystemFixtures();
}

/** Every mismatch a test found, with its scenario and call; each test expects none. */
let problems: string[] = [];

beforeEach(() => {
  problems = [];
});
afterEach(() => use(null));

/** Records a mismatch when `value` does not parse with `schema`. */
function conforms<T>(schema: ZodType<T>, value: unknown, label: string): void {
  const result = schema.safeParse(value);
  if (!result.success) problems.push(`${label}\n${z.prettifyError(result.error)}`);
}

/**
 * The answer of a call, or null when the fixture refuses it the way the API
 * would (a 4xx ApiError, e.g. the 409 of a launch while Nous is not
 * connected). Anything else thrown is a problem.
 */
async function answer<T>(call: Promise<T>, label: string): Promise<T | null> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) return null;
    problems.push(`${label} threw ${String(err)}`);
    return null;
  }
}

const zip = () => new File(['PK'], 'invoice-method.zip', { type: 'application/zip' });

// Hundreds of fixture calls per test (thousands for runs): a few seconds alone,
// but several times that when every package's suite runs at once (the api's
// PGlite suites take most of the machine), so these get far more than the
// 5 s default.
describe('fixtures conform to the shared contracts', { timeout: 120_000 }, () => {
  it('suites', async () => {
    for (const name of SCENARIO_NAMES) {
      use(name);
      const at = (call: string) => `${call} in scenario ${name ?? 'default'}`;
      const rows = await listSuites();
      conforms(SuiteListRowSchema.array(), rows, at('GET /suites'));
      conforms(SuiteReloadResultSchema, await reloadSuites(), at('POST /suites/reload'));
      // The missing-folders scenario draws the list's rows only, not those suites' pages.
      for (const row of rows.filter((r) => !MISSING_FOLDERS.includes(r.name))) {
        const current = await getSuite(row.suiteId);
        conforms(SuiteDetailSchema, current, at(`GET /suites/${row.suiteId}`));
        const history = await getSuiteHistory(row.suiteId);
        conforms(SuiteHistoryEntrySchema.array(), history, at('GET /suites/:id/history'));
        for (const version of current.versions) {
          const suite = await getSuite(version.suiteId);
          conforms(SuiteDetailSchema, suite, at(`GET /suites/${version.suiteId}`));
          for (const task of suite.tasks) {
            const label = at(`task ${task.key} of ${version.suiteId}`);
            const detail = await getTask(suite.suiteId, task.key);
            conforms(TaskDetailSchema, detail, label);
            const versions = await getTaskHistory(suite.suiteId, task.key);
            conforms(TaskVersionEntrySchema.array(), versions, label);
            for (const other of current.versions) {
              if (other.suiteId === version.suiteId) continue;
              const diff = await getTaskDiff(version.suiteId, task.key, other.suiteId);
              conforms(TaskDiffSchema, diff, `${label} against ${other.suiteId}`);
            }
          }
        }
      }
      const preview = await getFixturePreview('suite', 'total_due', 'invoices.csv');
      conforms(TablePreviewSchema.nullable(), preview, at('fixture preview'));
    }
    expect(problems).toEqual([]);
  });

  it('resources', async () => {
    for (const name of SCENARIO_NAMES) {
      use(name);
      const at = (call: string) => `${call} in scenario ${name ?? 'default'}`;
      conforms(ResourceCountsSchema, await getResourceCounts(), at('GET /resources/counts'));
      const skills = await listSkills();
      conforms(SkillRowSchema.array(), skills, at('GET /resources/skills'));
      for (const id of [...skills.map((s) => s.id), SKILL_INVOICE_METHOD_110_ID]) {
        const detail = await getSkill(id);
        conforms(SkillDetailSchema, detail, at(`GET /resources/skills/${id}`));
        for (const file of detail.files) {
          const content = await getSkillFile(id, file.path);
          conforms(SkillFileContentSchema, content, at(`skill file ${file.path}`));
        }
      }
      const validation = await validateSkillUpload(zip());
      conforms(SkillUploadValidationSchema, validation, at('POST /resources/skills/validate'));
      if (validation.token) {
        const confirmed = await confirmSkillUpload(validation.token);
        conforms(SkillRowSchema, confirmed, at('POST /resources/skills'));
      }
      conforms(DocumentRowSchema.array(), await listDocuments(), at('GET /resources/documents'));
      const upload = await uploadDocument(new File(['# t'], 'terms.md', { type: 'text/markdown' }));
      conforms(DocumentRowSchema, upload, at('POST /resources/documents'));
      const servers = await listMcpServers();
      conforms(McpServerRowSchema.array(), servers, at('GET /resources/mcp-servers'));
      for (const server of servers) {
        conforms(McpTestViewSchema, await testMcpServer({ id: server.id }), at('test by id'));
        const edited = await saveMcpServer({ ...server, timeoutS: 45 }, server.id);
        conforms(McpServerRowSchema, edited, at(`PUT /resources/mcp-servers/${server.id}`));
      }
      for (const input of [MCP_INVOICE_DB_INPUT, MCP_VENDOR_API_INPUT]) {
        conforms(McpTestViewSchema, await testMcpServer(input), at(`test ${input.name}`));
        const created = await saveMcpServer({ ...input, name: `${input.name}-2` });
        conforms(McpServerRowSchema, created, at('POST /resources/mcp-servers'));
      }
      conforms(SecretRowSchema.array(), await listSecrets(), at('GET /resources/secrets'));
      conforms(SecretRowSchema.array(), await checkSecrets(), at('GET /resources/secrets?refresh'));
    }
    expect(problems).toEqual([]);
  });

  it('configurations', async () => {
    for (const name of SCENARIO_NAMES) {
      use(name);
      const at = (call: string) => `${call} in scenario ${name ?? 'default'}`;
      const rows = await listConfigurations();
      conforms(ConfigurationListRowSchema.array(), rows, at('GET /configurations'));
      const options = await getConfigurationFormOptions();
      conforms(ConfigurationFormOptionsSchema, options, at('GET /configurations/form-options'));
      conforms(ConfigurationDraftSchema, await getConfigurationDraft('new'), at('new draft'));
      for (const row of rows) {
        const detail = await getConfiguration(row.id);
        conforms(ConfigurationDetailSchema, detail, at(`GET /configurations/${row.id}`));
        for (const mode of ['edit', 'duplicate'] as const) {
          const draft = await getConfigurationDraft(mode, row.id);
          conforms(ConfigurationDraftSchema, draft, at(`${mode} draft of ${row.name}`));
          // A prefilled draft is a body the API accepts as it stands.
          conforms(ConfigurationInputSchema, draft.values, at(`${mode} draft values`));
        }
        const saved = await saveConfiguration({ ...(await draftOf(row.id)), maxTurns: 30 }, row.id);
        conforms(ConfigurationSaveResultSchema, saved, at(`PUT /configurations/${row.id}`));
      }
      if (rows.length > 0) {
        const diff = await diffConfigurations(rows.map((r) => r.latest.versionId));
        conforms(ConfigDiffSchema, diff, at('GET /configurations/diff'));
      }
    }
    expect(problems).toEqual([]);
  });

  it('system', async () => {
    for (const name of SCENARIO_NAMES) {
      use(name);
      const at = (call: string) => `${call} in scenario ${name ?? 'default'}`;
      conforms(SystemSummarySchema, await getSystemSummary(), at('GET /system/summary'));
      conforms(SandboxStatusSchema, await getSandboxStatus(), at('GET /system/sandbox'));
      const summary = await getSystemSummary();
      const event = { type: 'summary', at: '2026-10-23T15:23:42Z', summary };
      conforms(SystemEventSchema, event, at('GET /system/events'));
    }
    expect(problems).toEqual([]);
  });

  it('providers', async () => {
    for (const name of SCENARIO_NAMES) {
      use(name);
      const at = (call: string) => `${call} in scenario ${name ?? 'default'}`;
      conforms(ProvidersResponseSchema, await listProviders(), at('GET /providers'));
      conforms(NousLoginSchema, await getNousLogin(), at('GET /providers/nous/login'));
      for (const outcome of LOGIN_OUTCOMES) {
        conforms(NousLoginSchema, await startNousLogin(), at('POST /providers/nous/login'));
        conforms(ProvidersResponseSchema, await listProviders(), at('GET /providers (waiting)'));
        simulateNousLogin(outcome);
        conforms(NousLoginSchema, await getNousLogin(), at(`login ending in ${outcome}`));
        conforms(ProvidersResponseSchema, await listProviders(), at(`providers after ${outcome}`));
      }
      await startNousLogin();
      await cancelNousLogin();
      conforms(NousLoginSchema, await getNousLogin(), at('DELETE /providers/nous/login'));
      await logoutNous();
      conforms(ProvidersResponseSchema, await listProviders(), at('POST /providers/nous/logout'));
    }
    expect(problems).toEqual([]);
  });

  it('experiments', async () => {
    const compared = new Set<string>();
    for (const name of SCENARIO_NAMES) {
      use(name);
      const at = (call: string) => `${call} in scenario ${name ?? 'default'}`;
      const rows = await listExperiments();
      conforms(ExperimentListRowSchema.array(), rows, at('GET /experiments'));
      const options = await getNewExperimentOptions();
      conforms(NewExperimentOptionsSchema, options, at('GET /experiments/new-options'));
      for (const suite of options.suites) {
        const input = launchInput(options, suite);
        if (!input) continue;
        const estimate = await estimateExperiment({
          suiteId: input.suiteId,
          versionIds: [input.baselineVersionId, ...input.candidateVersionIds],
          taskCount: input.taskKeys.length,
          repetitions: input.repetitions,
          concurrency: input.concurrency,
        });
        conforms(ExperimentEstimateViewSchema, estimate, at('GET /experiments/estimate'));
        conforms(LaunchExperimentInputSchema, input, at('the POST /experiments body'));
        const launched = await answer(launchExperiment(input), at('POST /experiments'));
        if (launched) conforms(LaunchExperimentResultSchema, launched, at('POST /experiments'));
      }
      const hashes = new Map(options.configurations.map((c) => [c.versionId, c.configHash]));
      for (const row of rows) {
        const label = (call: string) => at(`${call} of ${row.name}`);
        const detail = await getExperiment(row.id);
        conforms(ExperimentDetailSchema, detail, label('GET /experiments/:id'));
        for (const event of experimentEvents(detail, row)) {
          conforms(ExperimentEventSchema, event, label(`the ${event.type} event`));
        }
        for (const candidate of detail.candidates) {
          const query = { candidate: candidate.versionId };
          const view = await getComparison(row.id, query);
          conforms(ComparisonViewSchema, view, label(`comparison with ${candidate.name}`));
          // A view an earlier scenario served already had its keys and filters checked.
          const seen = JSON.stringify(view);
          if (compared.has(seen)) continue;
          compared.add(seen);
          for (const { value: key } of view.scoreKeyOptions) {
            for (const filter of COMPARISON_FILTERS) {
              const variant = await getComparison(row.id, { ...query, key, filter });
              conforms(ComparisonViewSchema, variant, label(`comparison ${key} ${filter}`));
            }
          }
        }
        const resume = { spendCeilingUsd: (detail.spend.ceilingUsd ?? 0) + 1 };
        conforms(ResumeExperimentInputSchema, resume, label('the resume body'));
        const actions = [
          ['pause', () => pauseExperiment(row.id)],
          ['resume', () => resumeExperiment(row.id, resume)],
          ['cancel', () => cancelExperiment(row.id)],
          ['retry-failed', () => retryFailedRuns(row.id)],
        ] as const;
        for (const [call, action] of actions) {
          const result = await answer(action(), label(`POST /experiments/:id/${call}`));
          if (result) conforms(ExperimentActionResultSchema, result, label(call));
        }
        const draft = await duplicateExperiment(row.id);
        conforms(NewExperimentDraftSchema, draft, label('POST /experiments/:id/duplicate'));
        // A Duplicate draft is a body the API accepts once the form adds the hashes it shows.
        const ids = [draft.values.baselineVersionId, ...draft.values.candidateVersionIds];
        const expectedConfigHashes = Object.fromEntries(ids.map((v) => [v, hashes.get(v) ?? '']));
        const body = { ...draft.values, expectedConfigHashes };
        conforms(LaunchExperimentInputSchema, body, label('the duplicate draft values'));
      }
    }
    expect(problems).toEqual([]);
  });

  it('runs', async () => {
    const seen = new Set<string>();
    for (const name of SCENARIO_NAMES) {
      use(name);
      const at = (call: string) => `${call} in scenario ${name ?? 'default'}`;
      for (const experiment of await listExperiments()) {
        const label = (call: string) => at(`${call} of ${experiment.name}`);
        const all = await listRuns(experiment.id);
        conforms(RunListResultSchema, all, label('GET /experiments/:id/runs'));
        // Filters and runs an earlier scenario served unchanged were checked there.
        if (!seen.has(JSON.stringify(all))) {
          seen.add(JSON.stringify(all));
          for (const filters of runFilterVariants(all)) {
            const result = await listRuns(experiment.id, filters);
            conforms(RunListResultSchema, result, label(`runs ${JSON.stringify(filters)}`));
          }
        }
        for (const row of all.rows) {
          conforms(ExperimentEventSchema, runEvent(row), label(`the run event of ${row.id}`));
          if (seen.has(JSON.stringify(row))) continue;
          seen.add(JSON.stringify(row));
          const detail = await getRun(row.id);
          conforms(RunDetailSchema, detail, label(`GET /runs/${row.id}`));
          const events = detail.timeline.events;
          for (const after of [0, events[Math.floor(events.length / 2)]?.seq ?? 0]) {
            const page = await listRunEvents(row.id, after);
            conforms(RunEventsPageSchema, page, label(`events of ${row.id} after ${after}`));
          }
          for (const artifact of detail.artifacts.items) {
            const preview = await getArtifactPreview(row.id, artifact.id);
            conforms(TablePreviewSchema.nullable(), preview, label(`preview of ${artifact.path}`));
          }
        }
        const actions = [
          ['rescore', rescoreRun],
          ['retry', retryRun],
          ['cancel', cancelRun],
        ] as const;
        // One run of each status, for the single-run actions.
        for (const id of new Map(all.rows.map((r) => [r.status, r.id])).values()) {
          for (const [call, action] of actions) {
            const result = await answer(action(id), label(`POST /runs/:id/${call}`));
            if (result) conforms(RunActionResultSchema, result, label(call));
          }
        }
        const runIds = all.rows.map((r) => r.id);
        conforms(BulkRunActionInputSchema, { runIds }, label('the bulk body'));
        const rescored = await rescoreRuns(experiment.id, runIds);
        conforms(BulkRescoreResultSchema, rescored, label('POST /experiments/:id/runs/rescore'));
        for (const row of all.rows.filter((r) => r.status === 'scored').slice(0, 3)) {
          for (const joined of [false, true]) {
            const single = rescoreRunFixture(row.id, joined);
            conforms(RescoreRunResultSchema, single, label(`POST /runs/${row.id}/rescore`));
          }
        }
        const retried = await retryRuns(experiment.id, runIds);
        conforms(BulkRunActionResultSchema, retried, label('POST /experiments/:id/runs/retry'));
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('fixture request bodies are valid', () => {
  it('the sample MCP definitions pass the input rules', () => {
    conforms(McpServerInputSchema, MCP_INVOICE_DB_INPUT, 'invoice-db');
    conforms(McpServerInputSchema, MCP_VENDOR_API_INPUT, 'vendor-api');
    expect(problems).toEqual([]);
  });
});

async function draftOf(id: string) {
  return (await getConfigurationDraft('edit', id)).values;
}

/** The body New experiment builds: every valid task, the first configuration against the rest. */
function launchInput(
  options: NewExperimentOptions,
  suite: NewExperimentSuiteOption,
): LaunchExperimentInput | null {
  const [baseline, ...candidates] = options.configurations;
  if (!baseline || candidates.length === 0) return null;
  return {
    name: 'Contract check',
    description: '',
    suiteId: suite.suiteId,
    taskKeys: suite.tasks.filter((t) => t.valid).map((t) => t.key),
    baselineVersionId: baseline.versionId,
    candidateVersionIds: candidates.map((c) => c.versionId),
    repetitions: options.defaults.repetitions,
    concurrency: Math.min(options.defaults.concurrency, Math.max(1, options.maxConcurrency)),
    spendCeilingUsd: 2,
    timeBudgetOverrideS: null,
    expectedConfigHashes: Object.fromEntries(
      options.configurations.map((c) => [c.versionId, c.configHash]),
    ),
  };
}

/** The experiment stream's events as the API would derive them from the same records. */
function experimentEvents(detail: ExperimentDetail, row: ExperimentListRow): ExperimentEvent[] {
  const at = detail.lastEventAt ?? detail.createdAt;
  return [
    { type: 'counts', at, counts: detail.counts, doneRuns: row.doneRuns, spend: detail.spend },
    {
      type: 'experiment',
      at,
      status: detail.status,
      pauseReason: detail.pauseReason,
      failure: detail.failure,
      verdicts: row.verdicts,
      verdictUpdatedAt:
        detail.verdicts
          .flatMap((v) => v.history.map((h) => h.at))
          .sort()
          .pop() ?? null,
    },
    ...detail.feed.map((entry) => ({ type: 'feed' as const, at: entry.finishedAt, entry })),
  ];
}

/** The `run` event that patches a Runs tab row. */
function runEvent(row: RunRow): ExperimentEvent {
  return {
    type: 'run',
    at: row.finishedAt ?? '2026-10-23T15:23:42Z',
    runId: row.id,
    status: row.status,
    attempt: row.attempts,
    primaryScore: row.primaryScore,
    finishedAt: row.finishedAt,
    generation: row.generation,
    rescorePending: row.rescorePending,
  };
}

/** Filters and sorts the Runs tab offers, built from the experiment's first row. */
function runFilterVariants(result: RunListResult): RunFilters[] {
  const first = result.rows[0];
  return [
    { configuration: first?.configuration.name },
    { configuration: first?.configuration.versionId, task: first?.taskKey },
    { configuration: 'all', task: 'all' },
    { status: 'execution_error' },
    { scoreStatus: 'ungradable' },
    { hasExecutionError: true },
    { ungradable: true },
    ...RUN_SORT_KEYS.flatMap((sort) => [{ sort }, { sort, dir: 'asc' as const }]),
  ];
}
