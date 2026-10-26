import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { McpServerInput } from '@hermes-evals/shared';
import { canonicalJson } from '../../queue/queues.js';
import {
  definitionHash,
  definitionOf,
  planEdit,
  versionColumns,
  type LatestVersion,
} from './definition.js';

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

describe('a header prefix (Phase 7)', () => {
  /** The hash as it was computed before prefixes existed, written out by hand. */
  const hashBeforePhase7 = (def: McpServerInput): string =>
    createHash('sha256')
      .update(
        canonicalJson({
          name: def.name,
          transport: def.transport,
          command: def.command,
          args: def.args,
          envNames: [...def.envNames].sort(),
          url: def.url,
          headers: def.headers
            .map((h) => ({ header: h.header.toLowerCase(), env: h.env }))
            .sort((a, b) => (a.header < b.header ? -1 : a.header > b.header ? 1 : 0)),
          include: [...def.include].sort(),
          exclude: [...def.exclude].sort(),
          timeoutS: def.timeoutS,
        }),
      )
      .digest('hex');
  const bearer: McpServerInput = {
    ...http,
    headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN', prefix: 'Bearer ' }],
  };

  it('keeps the hash of a definition without one, so no new version is made for it', () => {
    expect(definitionHash(http)).toBe(hashBeforePhase7(http));
    expect(definitionHash(stdio)).toBe(hashBeforePhase7(stdio));
  });

  it('changes the hash when a prefix is set, changed or removed', () => {
    const plain = { ...bearer, headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }] };
    const token = {
      ...bearer,
      headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN', prefix: 'Token ' }],
    };
    const hashes = new Set([plain, bearer, token].map(definitionHash));
    expect(hashes.size).toBe(3);
    // Header case still does not matter, the prefix's does.
    expect(
      definitionHash({
        ...bearer,
        headers: [{ header: 'authorization', env: 'VENDOR_API_TOKEN', prefix: 'Bearer ' }],
      }),
    ).toBe(definitionHash(bearer));
    expect(
      definitionHash({
        ...bearer,
        headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN', prefix: 'bearer ' }],
      }),
    ).not.toBe(definitionHash(bearer));
  });

  it('stores the prefix only when there is one, and reads it back', () => {
    const columns = versionColumns(bearer);
    expect(columns.headers).toEqual(bearer.headers);
    expect(versionColumns(http).headers).toEqual(http.headers);
    expect(versionColumns(http).headers.every((h) => !('prefix' in h))).toBe(true);
    const row = { ...columns, id: 'v1' } as unknown as Parameters<typeof definitionOf>[1];
    expect(definitionOf(bearer.name, row).headers).toEqual(bearer.headers);
  });

  it('makes adding a prefix to a frozen definition its next version, and an unfrozen one in place', () => {
    const was: LatestVersion = {
      definition: http,
      version: 1,
      definitionHash: definitionHash(http),
      frozen: true,
    };
    const next = {
      ...http,
      headers: [{ ...http.headers[0]!, prefix: 'Bearer ' }, http.headers[1]!],
    };
    expect(planEdit(was, next)).toEqual({
      kind: 'new_version',
      version: 2,
      definitionHash: definitionHash(next),
    });
    expect(planEdit({ ...was, frozen: false }, next)).toEqual({
      kind: 'in_place',
      definitionHash: definitionHash(next),
      resetTest: true,
    });
  });
});
