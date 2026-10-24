import { describe, expect, it } from 'vitest';
import type { McpServerInput } from '@hermes-evals/shared';
import { definitionHash, planEdit, type LatestVersion } from './definition.js';

const stdio: McpServerInput = {
  name: 'invoice-db',
  transport: 'stdio',
  command: 'invoice-db-mcp',
  args: ['--read-only', '--limit=10'],
  envNames: ['INVOICE_DB_URL', 'INVOICE_DB_REGION'],
  url: null,
  headers: [],
  include: ['list_invoices', 'get_invoice'],
  exclude: [],
  timeoutS: 30,
};

const http: McpServerInput = {
  name: 'vendor-api',
  transport: 'http',
  command: null,
  args: [],
  envNames: [],
  url: 'https://vendor-api.example.com/mcp',
  headers: [
    { header: 'Authorization', env: 'VENDOR_API_TOKEN' },
    { header: 'X-Tenant', env: 'VENDOR_TENANT' },
  ],
  include: [],
  exclude: ['delete_*'],
  timeoutS: 60,
};

describe('definitionHash', () => {
  it('is a sha256 that depends only on the definition', () => {
    expect(definitionHash(stdio)).toMatch(/^[0-9a-f]{64}$/);
    expect(definitionHash({ ...stdio })).toBe(definitionHash(stdio));
    // Key order of the object never matters.
    const reordered = Object.fromEntries(Object.entries(stdio).reverse()) as McpServerInput;
    expect(definitionHash(reordered)).toBe(definitionHash(stdio));
  });

  it('ignores the order of env names, tool filters and headers, and header case', () => {
    expect(
      definitionHash({
        ...stdio,
        envNames: [...stdio.envNames].reverse(),
        include: [...stdio.include].reverse(),
      }),
    ).toBe(definitionHash(stdio));
    expect(
      definitionHash({
        ...http,
        headers: [
          { header: 'x-tenant', env: 'VENDOR_TENANT' },
          { header: 'AUTHORIZATION', env: 'VENDOR_API_TOKEN' },
        ],
      }),
    ).toBe(definitionHash(http));
  });

  it('changes with everything Hermes is given, including the name and the order of args', () => {
    const base = definitionHash(stdio);
    const variants: McpServerInput[] = [
      { ...stdio, name: 'invoices' },
      { ...stdio, command: 'invoice-db-mcp2' },
      { ...stdio, args: [...stdio.args].reverse() },
      { ...stdio, envNames: ['INVOICE_DB_URL'] },
      { ...stdio, include: ['list_invoices'] },
      { ...stdio, exclude: ['delete_invoice'] },
      { ...stdio, timeoutS: 31 },
    ];
    const hashes = variants.map(definitionHash);
    expect(hashes).not.toContain(base);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(
      definitionHash({ ...http, headers: [{ header: 'Authorization', env: 'OTHER_TOKEN' }] }),
    ).not.toBe(definitionHash(http));
    expect(definitionHash({ ...http, url: 'https://vendor-api.example.com/mcp/v2' })).not.toBe(
      definitionHash(http),
    );
  });

  it('does not let an include entry pose as an exclude entry', () => {
    expect(definitionHash({ ...stdio, include: [], exclude: ['get_invoice'] })).not.toBe(
      definitionHash({ ...stdio, include: ['get_invoice'], exclude: [] }),
    );
  });
});

describe('planEdit', () => {
  const latest = (over: Partial<LatestVersion> = {}): LatestVersion => ({
    definition: stdio,
    version: 1,
    definitionHash: definitionHash(stdio),
    frozen: false,
    ...over,
  });

  it('leaves an identical save alone, frozen or not', () => {
    expect(planEdit(latest(), { ...stdio })).toEqual({ kind: 'unchanged' });
    expect(planEdit(latest({ frozen: true }), { ...stdio })).toEqual({ kind: 'unchanged' });
  });

  it('rewrites an unfrozen definition in place and resets its test only when it changed', () => {
    const changed = { ...stdio, timeoutS: 45 };
    expect(planEdit(latest(), changed)).toEqual({
      kind: 'in_place',
      definitionHash: definitionHash(changed),
      resetTest: true,
    });
    const reordered = { ...stdio, envNames: [...stdio.envNames].reverse() };
    expect(planEdit(latest(), reordered)).toEqual({
      kind: 'in_place',
      definitionHash: definitionHash(stdio),
      resetTest: false,
    });
  });

  it('adds the next version for a frozen definition, unless only an order changed', () => {
    const changed = { ...stdio, args: [] };
    expect(planEdit(latest({ frozen: true, version: 3 }), changed)).toEqual({
      kind: 'new_version',
      version: 4,
      definitionHash: definitionHash(changed),
    });
    expect(
      planEdit(latest({ frozen: true }), { ...stdio, include: [...stdio.include].reverse() }),
    ).toEqual({ kind: 'unchanged' });
    // A transport change is a new definition like any other.
    expect(planEdit(latest({ frozen: true }), { ...http, name: stdio.name }).kind).toBe(
      'new_version',
    );
  });

  it('allows a rename only while no version has been used', () => {
    const renamed = { ...stdio, name: 'invoices' };
    expect(planEdit(latest(), renamed)).toMatchObject({ kind: 'in_place', resetTest: true });
    expect(planEdit(latest({ frozen: true }), renamed)).toEqual({ kind: 'refuse_rename' });
    // Version 2 exists only because version 1 froze, so the name is fixed even
    // while version 2 itself is unused.
    expect(planEdit(latest({ version: 2 }), renamed)).toEqual({ kind: 'refuse_rename' });
  });
});
