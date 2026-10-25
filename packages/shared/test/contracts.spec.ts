import { describe, expect, it } from 'vitest';
import {
  ConfigurationInputSchema,
  McpServerInputSchema,
  McpServerRowSchema,
  mcpRouteProblems,
  SecretRowSchema,
  SkillConfirmRequestSchema,
  SuiteReloadRequestSchema,
  type ConfigurationInput,
  type McpServerInput,
} from '../src/contracts/index.js';

const STDIO: McpServerInput = {
  name: 'invoice-db',
  transport: 'stdio',
  command: 'python3',
  args: ['/opt/mcp/invoice_db.py'],
  envNames: ['INVOICE_DB_URL'],
  url: null,
  headers: [],
  include: ['list_invoices', 'get_invoice'],
  exclude: [],
  timeoutS: 30,
};

const HTTP: McpServerInput = {
  name: 'vendor-api',
  transport: 'http',
  command: null,
  args: [],
  envNames: [],
  url: 'https://vendor-api.example.com/mcp',
  headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }],
  include: [],
  exclude: [],
  timeoutS: 60,
};

const CONFIG: ConfigurationInput = {
  name: 'with-skill',
  model: 'openai/gpt-6.1-sol',
  provider: 'nous',
  baseUrl: null,
  toolsets: ['file', 'terminal'],
  memoryEnabled: false,
  skillIds: ['skill_01JAX9C41E07'],
  documentIds: [],
  mcpServerVersionIds: [],
  maxTurns: 20,
  timeBudgetS: 300,
  duplicatedFromVersionId: 'cfgv_01JAX7BASE1',
};

/** Issue paths of a failed parse, joined with dots. */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  expect(result.success).toBe(false);
  return result.error!.issues.map((i) => i.path.join('.'));
}

describe('McpServerInputSchema', () => {
  it('accepts a stdio and an http definition', () => {
    expect(McpServerInputSchema.parse(STDIO)).toEqual(STDIO);
    expect(McpServerInputSchema.parse(HTTP)).toEqual(HTTP);
    expect(
      McpServerInputSchema.safeParse({ ...HTTP, url: 'http://10.0.0.5:8931/mcp' }).success,
    ).toBe(true);
  });

  it('requires exactly one transport shape', () => {
    expect(issuePaths(McpServerInputSchema.safeParse({ ...STDIO, command: '  ' }))).toEqual([
      'command',
    ]);
    expect(issuePaths(McpServerInputSchema.safeParse({ ...STDIO, command: null }))).toEqual([
      'command',
    ]);
    expect(
      issuePaths(McpServerInputSchema.safeParse({ ...STDIO, url: 'https://example.com/mcp' })),
    ).toEqual(['url']);
    expect(issuePaths(McpServerInputSchema.safeParse({ ...STDIO, headers: HTTP.headers }))).toEqual(
      ['headers'],
    );
    expect(issuePaths(McpServerInputSchema.safeParse({ ...HTTP, url: null }))).toEqual(['url']);
    expect(issuePaths(McpServerInputSchema.safeParse({ ...HTTP, command: 'npx' }))).toEqual([
      'command',
    ]);
    expect(issuePaths(McpServerInputSchema.safeParse({ ...HTTP, args: ['-y'] }))).toEqual(['args']);
    expect(issuePaths(McpServerInputSchema.safeParse({ ...HTTP, envNames: ['TOKEN'] }))).toEqual([
      'envNames',
    ]);
  });

  it('refuses urls that are not http(s) or carry credentials', () => {
    for (const url of [
      'ftp://vendor-api.example.com/mcp',
      'https://user:secret@vendor-api.example.com/mcp',
      'https://token@vendor-api.example.com',
      'vendor-api.example.com/mcp',
      'https://',
      'https://vendor api.example.com',
    ]) {
      expect(McpServerInputSchema.safeParse({ ...HTTP, url }).success, url).toBe(false);
    }
  });

  it('checks names, variables, headers, tool lists and the timeout', () => {
    const bad: [Partial<McpServerInput>, string][] = [
      [{ name: 'Invoice-DB' }, 'name'],
      [{ name: '' }, 'name'],
      [{ name: `a${'b'.repeat(63)}` }, 'name'],
      [{ envNames: ['invoice_db_url'] }, 'envNames'],
      [{ envNames: ['INVOICE_DB_URL', 'INVOICE_DB_URL'] }, 'envNames'],
      [{ include: ['get_invoice', 'get_invoice'] }, 'include'],
      [{ exclude: [''] }, 'exclude'],
      [{ timeoutS: 0 }, 'timeoutS'],
      [{ timeoutS: 3601 }, 'timeoutS'],
    ];
    for (const [change, path] of bad) {
      expect(issuePaths(McpServerInputSchema.safeParse({ ...STDIO, ...change }))).toEqual([path]);
    }
    const headers: McpServerInput['headers'][] = [
      [{ header: 'Authorization', env: 'vendor_token' }],
      [{ header: 'Bad Header', env: 'VENDOR_API_TOKEN' }],
      [
        { header: 'Authorization', env: 'A' },
        { header: 'authorization', env: 'B' },
      ],
      [{ header: 'Host', env: 'VENDOR_HOST' }],
    ];
    for (const value of headers) {
      expect(McpServerInputSchema.safeParse({ ...HTTP, headers: value }).success).toBe(false);
    }
    expect(McpServerInputSchema.safeParse({ ...STDIO, timeoutS: 1.5 }).success).toBe(false);
  });

  it('refuses on save what egress would refuse at registration', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ header: `X-H${i}`, env: `V${i}` }));
    const cases: [Partial<McpServerInput>, string][] = [
      [{ headers: [{ header: 'Proxy-Authenticate', env: 'VENDOR_PROXY' }] }, 'headers'],
      [{ headers: many }, 'headers'],
      [{ url: `https://vendor-api.example.com/${'a'.repeat(2048)}` }, 'url'],
    ];
    for (const [change, path] of cases) {
      expect(issuePaths(McpServerInputSchema.safeParse({ ...HTTP, ...change }))).toEqual([path]);
    }
    expect(mcpRouteProblems({ ...HTTP, headers: [{ header: 'proxy-authenticate' }] })).toEqual([
      'egress sets proxy-authenticate itself',
    ]);
    expect(mcpRouteProblems(HTTP)).toEqual([]);
    // A stored row keeps reading back; only input and the worker apply these rules.
    expect(
      McpServerRowSchema.safeParse({
        ...HTTP,
        headers: [{ header: 'Proxy-Authenticate', env: 'VENDOR_PROXY' }],
        id: 'mcp_1',
        versionId: 'mcpv_1',
        version: 1,
        definedAt: '2026-10-01T00:00:00.000Z',
        frozen: false,
        usedBy: [],
        lastTest: { status: 'untested' },
      }).success,
    ).toBe(true);
  });

  it('refuses platform variables and credentials, as env names and header variables', () => {
    for (const name of ['OPENROUTER_API_KEY', 'DATABASE_URL', 'HOME', 'PGPASSWORD', 'EGRESS_X']) {
      const stdio = McpServerInputSchema.safeParse({
        ...STDIO,
        envNames: ['INVOICE_DB_URL', name],
      });
      expect(stdio.success, name).toBe(false);
      expect(stdio.error?.issues).toEqual([
        expect.objectContaining({
          path: ['envNames'],
          message: `${name} is a platform variable or credential; it never enters a trial`,
        }),
      ]);
      const http = McpServerInputSchema.safeParse({
        ...HTTP,
        headers: [{ header: 'Authorization', env: name }],
      });
      expect(issuePaths(http), name).toEqual(['headers']);
    }
    expect(
      McpServerInputSchema.safeParse({ ...STDIO, envNames: ['OPENAI_API_KEY', 'NOUS_API_KEY'] })
        .error?.issues[0]?.message,
    ).toBe(
      'OPENAI_API_KEY and NOUS_API_KEY are platform variables or credentials; they never enter a trial',
    );
    // Names that only look alike are the user's.
    expect(
      McpServerInputSchema.safeParse({ ...STDIO, envNames: ['MY_DATABASE_URL'] }).success,
    ).toBe(true);
  });

  it('still reads back a stored row that names one, so GET keeps working', () => {
    const row = {
      ...STDIO,
      envNames: ['OPENROUTER_API_KEY'],
      id: 'mcp_01JAYINVOICE',
      versionId: 'mcpv_01JAYINVOIC1',
      version: 1,
      definedAt: '2026-10-23T10:00:00Z',
      frozen: false,
      usedBy: [],
      lastTest: { status: 'untested' },
    };
    expect(McpServerRowSchema.safeParse(row).success).toBe(true);
  });

  it('strips unknown fields, so the form may send a whole row back', () => {
    const parsed = McpServerInputSchema.parse({ ...STDIO, id: 'mcp_1', version: 3 });
    expect(parsed).toEqual(STDIO);
  });

  it('applies the same rules to rows', () => {
    const row = {
      ...HTTP,
      id: 'mcp_01JAYVENDOR',
      versionId: 'mcpv_01JAYVENDO1',
      version: 1,
      definedAt: '2026-10-23T10:00:00Z',
      frozen: false,
      usedBy: [],
      lastTest: { status: 'untested' },
    };
    expect(McpServerRowSchema.safeParse(row).success).toBe(true);
    expect(McpServerRowSchema.safeParse({ ...row, command: 'npx' }).success).toBe(false);
  });
});

describe('SecretRowSchema', () => {
  const worker = {
    name: 'INVOICE_DB_URL',
    set: true,
    source: 'worker',
    exposure: 'readable_by_agent',
    referencedBy: [
      { kind: 'mcp_server', id: 'mcp_1', name: 'invoice-db', via: 'env', header: null },
    ],
    lastCheckedAt: '2026-10-23T15:02:00Z',
    checkedWhen: 'at worker start',
  };
  const egress = {
    ...worker,
    name: 'VENDOR_API_TOKEN',
    source: 'egress',
    exposure: 'egress_only',
    referencedBy: [
      {
        kind: 'mcp_server',
        id: 'mcp_2',
        name: 'vendor-api',
        via: 'header',
        header: 'Authorization',
      },
    ],
  };

  it('accepts a worker and an egress secret', () => {
    expect(SecretRowSchema.safeParse(worker).success).toBe(true);
    expect(SecretRowSchema.safeParse(egress).success).toBe(true);
  });

  it('ties exposure, reference kind and header to the source', () => {
    expect(issuePaths(SecretRowSchema.safeParse({ ...worker, exposure: 'egress_only' }))).toEqual([
      'exposure',
    ]);
    expect(
      issuePaths(SecretRowSchema.safeParse({ ...worker, referencedBy: egress.referencedBy })),
    ).toEqual(['referencedBy']);
    const headerless = [{ ...egress.referencedBy[0], header: null }];
    expect(issuePaths(SecretRowSchema.safeParse({ ...egress, referencedBy: headerless }))).toEqual([
      'referencedBy.0.header',
    ]);
    expect(SecretRowSchema.safeParse({ ...worker, source: 'worker environment' }).success).toBe(
      false,
    );
  });
});

describe('ConfigurationInputSchema', () => {
  it('accepts the sample configurations and a custom provider with its URL', () => {
    expect(ConfigurationInputSchema.parse(CONFIG)).toEqual(CONFIG);
    expect(
      ConfigurationInputSchema.safeParse({
        ...CONFIG,
        provider: 'custom',
        baseUrl: 'http://host.docker.internal:11434/v1',
        duplicatedFromVersionId: null,
      }).success,
    ).toBe(true);
  });

  it('refuses bad values with the field that is wrong', () => {
    const bad: [Partial<ConfigurationInput>, string][] = [
      [{ name: '' }, 'name'],
      [{ name: 'With Skill' }, 'name'],
      [{ model: ' ' }, 'model'],
      [{ provider: 'custom' }, 'baseUrl'],
      [{ provider: 'custom', baseUrl: 'https://key:secret@api.example.com/v1' }, 'baseUrl'],
      [{ provider: 'custom', baseUrl: 'file:///etc/passwd' }, 'baseUrl'],
      [{ baseUrl: 'https://api.example.com/v1' }, 'baseUrl'],
      [{ toolsets: ['file', 'file'] }, 'toolsets'],
      [{ toolsets: [''] }, 'toolsets'],
      [{ skillIds: ['skill_1', 'skill_1'] }, 'skillIds'],
      [{ mcpServerVersionIds: ['mcpv_1', 'mcpv_1'] }, 'mcpServerVersionIds'],
      [{ maxTurns: 0 }, 'maxTurns'],
      [{ maxTurns: 201 }, 'maxTurns'],
      [{ timeBudgetS: 29 }, 'timeBudgetS'],
      [{ timeBudgetS: 3601 }, 'timeBudgetS'],
    ];
    for (const [change, path] of bad) {
      expect(issuePaths(ConfigurationInputSchema.safeParse({ ...CONFIG, ...change }))).toEqual([
        path,
      ]);
    }
    expect(ConfigurationInputSchema.safeParse({ ...CONFIG, provider: 'azure' }).success).toBe(
      false,
    );
    expect(ConfigurationInputSchema.safeParse({ ...CONFIG, maxTurns: 2.5 }).success).toBe(false);
    const { duplicatedFromVersionId: _, ...withoutOrigin } = CONFIG;
    expect(ConfigurationInputSchema.safeParse(withoutOrigin).success).toBe(false);
  });
});

describe('small request bodies', () => {
  it('reload takes an optional path and nothing else', () => {
    expect(SuiteReloadRequestSchema.parse({})).toEqual({});
    expect(SuiteReloadRequestSchema.parse({ path: './suites/invoices-v1' })).toEqual({
      path: './suites/invoices-v1',
    });
    expect(SuiteReloadRequestSchema.safeParse({ path: '' }).success).toBe(false);
    expect(SuiteReloadRequestSchema.safeParse({ all: true }).success).toBe(false);
  });

  it('skill confirm needs its token', () => {
    expect(SkillConfirmRequestSchema.parse({ token: 'upl_valid_9c41e07d' })).toEqual({
      token: 'upl_valid_9c41e07d',
    });
    expect(SkillConfirmRequestSchema.safeParse({}).success).toBe(false);
    expect(SkillConfirmRequestSchema.safeParse({ token: '' }).success).toBe(false);
  });
});
