/**
 * Live mode of src/api/configurations.ts: each function calls its endpoint (method, path,
 * query, body, X-Requested-With) and parses the answer with its shared schema, so a field
 * the API renames or drops fails here as a contract error rather than somewhere in a page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_VERSIONS,
  configDiffFixture,
  draftFixture,
  formOptionsFixture,
  NEW_CONFIGURATION_INPUT,
  versionRef,
} from '@/fixtures/configurations';

interface Sent {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

let sent: Sent[] = [];
/** The answer per "METHOD /path"; anything else is a 404. */
let answers: Record<string, unknown> = {};

const latest = CONFIG_VERSIONS['with-skill'];
const listRow = {
  id: latest.configurationId,
  name: latest.name,
  createdAt: latest.createdAt,
  latest,
  usedInExperiments: 3,
};
const detail = {
  id: latest.configurationId,
  name: latest.name,
  createdAt: latest.createdAt,
  shown: latest,
  latest,
  versions: [latest],
  duplicatedFrom: versionRef(CONFIG_VERSIONS.baseline),
  differsFromSource: ['skills'],
  usedIn: [],
};
const saved = {
  configurationId: latest.configurationId,
  versionId: 'cfgv_2',
  version: 2,
  createdNewVersion: true,
};

beforeAll(() => {
  vi.stubEnv('VITE_API_MODE', 'live');
  vi.resetModules();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

beforeEach(() => {
  sent = [];
  answers = {};
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const method = init.method ?? 'GET';
    sent.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const key = `${method} ${url.pathname}`;
    if (!(key in answers)) {
      return new Response(JSON.stringify({ statusCode: 404, message: `${key} not found` }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(answers[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

const api = () => import('@/api/configurations');

describe('configurations, live', () => {
  it('reads the list, a detail and an older version with their schemas', async () => {
    const { listConfigurations, getConfiguration } = await api();
    answers['GET /api/configurations'] = [listRow];
    answers[`GET /api/configurations/${latest.configurationId}`] = detail;
    answers[`GET /api/configurations/${latest.configurationId}/versions/1`] = detail;
    expect(await listConfigurations()).toEqual([listRow]);
    expect((await getConfiguration(latest.configurationId)).name).toBe('with-skill');
    await getConfiguration(latest.configurationId, 1);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /api/configurations',
      `GET /api/configurations/${latest.configurationId}`,
      `GET /api/configurations/${latest.configurationId}/versions/1`,
    ]);
  });

  it('refuses an answer that breaks the contract, naming the field', async () => {
    const { getConfiguration } = await api();
    const { usedIn: _dropped, ...withoutUsage } = detail;
    answers[`GET /api/configurations/${latest.configurationId}`] = withoutUsage;
    await expect(getConfiguration(latest.configurationId)).rejects.toMatchObject({
      kind: 'contract',
      message: expect.stringContaining('usedIn'),
    });
  });

  it('diffs two or three versions with ?versions=a,b', async () => {
    const { diffConfigurations } = await api();
    const diff = configDiffFixture([CONFIG_VERSIONS.baseline, latest]);
    answers['GET /api/configurations/diff'] = diff;
    const ids = [CONFIG_VERSIONS.baseline.versionId, latest.versionId];
    expect(await diffConfigurations(ids)).toEqual(diff);
    expect(sent[0]!.query).toEqual({ versions: ids.join(',') });
  });

  it('opens the form: options, new draft, edit draft, duplicate', async () => {
    const { getConfigurationFormOptions, getConfigurationDraft } = await api();
    answers['GET /api/configurations/form-options'] = formOptionsFixture(false);
    answers['GET /api/configurations/new-draft'] = draftFixture('new', null);
    answers[`GET /api/configurations/${latest.configurationId}/draft`] = draftFixture(
      'edit',
      latest,
    );
    answers[`POST /api/configurations/${latest.configurationId}/duplicate`] = draftFixture(
      'duplicate',
      latest,
    );
    expect((await getConfigurationFormOptions()).toolsets).toHaveLength(17);
    expect((await getConfigurationDraft('new')).values.name).toBe('');
    expect((await getConfigurationDraft('edit', latest.configurationId)).createsNewVersion).toBe(
      true,
    );
    expect((await getConfigurationDraft('duplicate', latest.configurationId)).mode).toBe(
      'duplicate',
    );
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /api/configurations/form-options',
      'GET /api/configurations/new-draft',
      `GET /api/configurations/${latest.configurationId}/draft`,
      `POST /api/configurations/${latest.configurationId}/duplicate`,
    ]);
    expect(sent[3]!.headers['x-requested-with']).toBe('hermes-evals');
  });

  it('saves: POST for a new configuration, PUT for an edit, with the form body', async () => {
    const { saveConfiguration } = await api();
    answers['POST /api/configurations'] = { ...saved, version: 1 };
    answers[`PUT /api/configurations/${latest.configurationId}`] = saved;
    const body = { ...NEW_CONFIGURATION_INPUT, name: 'or-baseline' };
    expect((await saveConfiguration(body)).version).toBe(1);
    expect(await saveConfiguration(body, latest.configurationId)).toEqual(saved);
    expect(sent.map((s) => [s.method, s.path, s.headers['x-requested-with']])).toEqual([
      ['POST', '/api/configurations', 'hermes-evals'],
      ['PUT', `/api/configurations/${latest.configurationId}`, 'hermes-evals'],
    ]);
    expect(sent[0]!.body).toEqual(body);
  });

  it('passes the API refusal through as an ApiError with its message', async () => {
    const { saveConfiguration } = await api();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            statusCode: 409,
            message: 'a configuration named baseline already exists',
          }),
          { status: 409 },
        ),
    );
    await expect(
      saveConfiguration({ ...NEW_CONFIGURATION_INPUT, name: 'baseline' }),
    ).rejects.toThrow(
      'POST /api/configurations → 409 · a configuration named baseline already exists',
    );
  });
});
