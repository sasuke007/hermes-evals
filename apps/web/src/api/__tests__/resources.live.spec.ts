/**
 * The resource library in live mode: each function calls its endpoint (plan 11) with the
 * method, path, body and CSRF header the API expects, and parses the answer with its shared
 * schema, so an answer that breaks the contract fails here as a `contract` ApiError. Runs the
 * data layer with VITE_API_MODE=live against a fetch stub that answers with the fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_POLICY,
  MCP_INVOICE_DB,
  MCP_INVOICE_DB_INPUT,
  MCP_TEST_PASSED,
  SKILL_INVOICE_METHOD,
  resourceCountsFixture,
  secretsFixture,
  skillDetailFixture,
  skillFileFixture,
  skillValidationFixture,
} from '@/fixtures/resources';

interface Sent {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

let sent: Sent[] = [];
/** What the stub answers next: [status, body]. */
let answer: (path: string, method: string) => [number, unknown] = () => [200, {}];

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
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const method = init.method ?? 'GET';
    sent.push({
      method,
      path: url.pathname,
      search: url.search,
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body:
        typeof init.body === 'string'
          ? JSON.parse(init.body)
          : init.body instanceof FormData
            ? init.body
            : undefined,
    });
    const [status, body] = answer(url.pathname, method);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
});

const api = () => import('@/api/resources');
const last = (): Sent => {
  const request = sent[sent.length - 1];
  if (!request) throw new Error('nothing was sent');
  return request;
};

describe('resources, live', () => {
  it('reads each list and parses it with its schema', async () => {
    const r = await api();
    answer = (path) => {
      if (path.endsWith('/counts')) return [200, resourceCountsFixture(false)];
      if (path.endsWith('/skills')) return [200, [SKILL_INVOICE_METHOD]];
      if (path.endsWith('/documents')) return [200, [DOCUMENT_POLICY]];
      if (path.endsWith('/mcp-servers')) return [200, [MCP_INVOICE_DB]];
      return [200, secretsFixture({ empty: false, set: true })];
    };
    expect(await r.getResourceCounts()).toEqual({
      skills: 1,
      documents: 1,
      mcpServers: 2,
      secrets: 2,
    });
    expect(last()).toMatchObject({ method: 'GET', path: '/api/resources/counts' });
    expect(await r.listSkills()).toEqual([SKILL_INVOICE_METHOD]);
    expect(await r.listDocuments()).toEqual([DOCUMENT_POLICY]);
    expect(await r.listMcpServers()).toEqual([MCP_INVOICE_DB]);
    expect((await r.listSecrets()).map((s) => s.name)).toEqual([
      'INVOICE_DB_URL',
      'VENDOR_API_TOKEN',
    ]);
    expect(last()).toMatchObject({ path: '/api/resources/secrets', search: '' });
    await r.checkSecrets();
    expect(last()).toMatchObject({ path: '/api/resources/secrets', search: '?refresh=true' });
  });

  it('refuses an answer that breaks the contract, naming the field', async () => {
    const r = await api();
    answer = () => [200, [{ ...SKILL_INVOICE_METHOD, contentHash: 'sha256:9c41' }]];
    const err = await r.listSkills().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'contract', status: 200 });
    expect(String((err as Error).message)).toContain('0.contentHash');
    // A secret row whose exposure does not follow its source.
    answer = () => [
      200,
      [{ ...secretsFixture({ empty: false, set: true })[0], exposure: 'egress_only' }],
    ];
    await expect(r.listSecrets()).rejects.toMatchObject({ kind: 'contract' });
  });

  it('opens a skill and one of its files, the path as one encoded segment', async () => {
    const r = await api();
    const id = SKILL_INVOICE_METHOD.id;
    answer = (path) =>
      path.includes('/files/')
        ? [200, skillFileFixture(id, 'examples/reconcile.py')]
        : [200, skillDetailFixture(id)];
    expect((await r.getSkill(id)).files).toHaveLength(4);
    expect(last().path).toBe(`/api/resources/skills/${id}`);
    await r.getSkillFile(id, 'examples/reconcile.py');
    expect(last().path).toBe(`/api/resources/skills/${id}/files/examples%2Freconcile.py`);
    expect(r.skillZipUrl(id)).toBe(`/api/resources/skills/${id}/zip`);
    expect(r.documentContentUrl('doc_1')).toBe('/api/resources/documents/doc_1/content');
  });

  it('validates a zip as multipart, then confirms with the token', async () => {
    const r = await api();
    const validation = skillValidationFixture('valid');
    answer = (path) =>
      path.endsWith('/validate') ? [200, validation] : [201, SKILL_INVOICE_METHOD];
    const zip = new File(['PK'], 'invoice-method.zip', { type: 'application/zip' });
    expect(await r.validateSkillUpload(zip)).toEqual(validation);
    const request = last();
    expect(request).toMatchObject({ method: 'POST', path: '/api/resources/skills/validate' });
    expect(request.headers['x-requested-with']).toBe('hermes-evals');
    expect(request.headers['content-type']).toBeUndefined();
    expect((request.body as FormData).get('file')).toBeInstanceOf(File);
    await r.confirmSkillUpload(validation.token!);
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/resources/skills',
      body: { token: validation.token },
    });
  });

  it('uploads a document as multipart', async () => {
    const r = await api();
    answer = () => [201, DOCUMENT_POLICY];
    const pdf = new File(['%PDF-'], 'vendor-policy-v3.pdf', { type: 'application/pdf' });
    expect(await r.uploadDocument(pdf)).toEqual(DOCUMENT_POLICY);
    expect(last()).toMatchObject({ method: 'POST', path: '/api/resources/documents' });
    expect((last().body as FormData).get('file')).toBeInstanceOf(File);
  });

  it('saves and tests MCP servers, by id or as the form holds them', async () => {
    const r = await api();
    answer = (path) => (path.endsWith('/test') ? [200, MCP_TEST_PASSED] : [201, MCP_INVOICE_DB]);
    await r.saveMcpServer(MCP_INVOICE_DB_INPUT);
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/resources/mcp-servers',
      body: MCP_INVOICE_DB_INPUT,
    });
    await r.saveMcpServer(MCP_INVOICE_DB_INPUT, MCP_INVOICE_DB.id);
    expect(last()).toMatchObject({
      method: 'PUT',
      path: `/api/resources/mcp-servers/${MCP_INVOICE_DB.id}`,
    });
    expect(await r.testMcpServer({ id: MCP_INVOICE_DB.id })).toEqual(MCP_TEST_PASSED);
    expect(last()).toMatchObject({
      method: 'POST',
      path: `/api/resources/mcp-servers/${MCP_INVOICE_DB.id}/test`,
      body: {},
    });
    await r.testMcpServer(MCP_INVOICE_DB_INPUT);
    expect(last()).toMatchObject({
      path: '/api/resources/mcp-servers/test',
      body: MCP_INVOICE_DB_INPUT,
    });
  });

  it('passes the API refusal through with its issues', async () => {
    const r = await api();
    answer = () => [
      400,
      {
        statusCode: 400,
        message: 'Validation failed',
        issues: [{ path: 'envNames', message: 'DATABASE_URL is a platform variable' }],
      },
    ];
    const err = await r
      .saveMcpServer({ ...MCP_INVOICE_DB_INPUT, envNames: ['DATABASE_URL'] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, kind: 'http' });
    expect((err as { issueFor(p: string): string | null }).issueFor('envNames')).toBe(
      'DATABASE_URL is a platform variable',
    );
  });
});
