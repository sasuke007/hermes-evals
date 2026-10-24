/**
 * Every fixture the suites, resources, configurations and system data layer
 * serves, in every scenario, parses with the shared contract the API answers
 * with. A fixture and its contract therefore cannot drift: a field renamed
 * on one side fails here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import {
  ConfigDiffSchema,
  ConfigurationDetailSchema,
  ConfigurationDraftSchema,
  ConfigurationFormOptionsSchema,
  ConfigurationInputSchema,
  ConfigurationListRowSchema,
  ConfigurationSaveResultSchema,
  DocumentRowSchema,
  McpServerInputSchema,
  McpServerRowSchema,
  McpTestViewSchema,
  ResourceCountsSchema,
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
  SystemSummarySchema,
  TablePreviewSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskVersionEntrySchema,
  WorkerSchema,
} from '@hermes-evals/shared';
import {
  diffConfigurations,
  getConfiguration,
  getConfigurationDraft,
  getConfigurationFormOptions,
  listConfigurations,
  saveConfiguration,
} from '@/api/configurations';
import { getNousLogin, listProviders } from '@/api/providers';
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
  getFixturePreview,
  getSuite,
  getSuiteHistory,
  getTask,
  getTaskDiff,
  getTaskHistory,
  listSuites,
  reloadSuites,
} from '@/api/suites';
import { getSandboxStatus, getSystemSummary, listWorkers } from '@/api/system';
import { NousLoginSchema, ProvidersResponseSchema } from '@/api/types/system';
import {
  MCP_INVOICE_DB_INPUT,
  MCP_VENDOR_API_INPUT,
  SKILL_INVOICE_METHOD_110_ID,
} from '@/fixtures/resources';
import { SCENARIOS } from '@/fixtures/scenarios';
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

const zip = () => new File(['PK'], 'invoice-method.zip', { type: 'application/zip' });

// Hundreds of fixture calls per test: well under a second alone, but slow when
// every package's suite runs at once, so these get more than the 5 s default.
describe('fixtures conform to the shared contracts', { timeout: 30_000 }, () => {
  it('suites', async () => {
    for (const name of SCENARIO_NAMES) {
      use(name);
      const at = (call: string) => `${call} in scenario ${name ?? 'default'}`;
      const rows = await listSuites();
      conforms(SuiteListRowSchema.array(), rows, at('GET /suites'));
      conforms(SuiteReloadResultSchema, await reloadSuites(), at('POST /suites/reload'));
      for (const row of rows) {
        const current = await getSuite(row.suiteId);
        conforms(SuiteDetailSchema, current, at(`GET /suites/${row.suiteId}`));
        const history = await getSuiteHistory(row.suiteId);
        conforms(SuiteHistoryEntrySchema.array(), history, at('GET /suites/:id/history'));
        for (const version of current.versions) {
          const suite = await getSuite(version.suiteId);
          conforms(SuiteDetailSchema, suite, at(`GET /suites/${version.suiteId}`));
          for (const task of suite.tasks) {
            const label = at(`task ${task.key} of ${version.suiteId}`);
            conforms(TaskDetailSchema, await getTask(suite.suiteId, task.key), label);
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
      conforms(WorkerSchema.array(), await listWorkers(), at('GET /system/workers'));
      conforms(SandboxStatusSchema, await getSandboxStatus(), at('GET /system/sandbox'));
      conforms(ProvidersResponseSchema, await listProviders(), at('GET /providers'));
      conforms(NousLoginSchema, await getNousLogin(), at('GET /providers/nous/login'));
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
