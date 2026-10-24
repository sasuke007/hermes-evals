import { describe, expect, it } from 'vitest';
import type { McpServerInput } from '@hermes-evals/shared';
import { globToRegExp, hermesMcpEntry, toolOffered } from './hermes-config.js';

const stdio: McpServerInput = {
  name: 'invoice-db',
  transport: 'stdio',
  command: 'invoice-db-mcp',
  args: ['--verbose'],
  envNames: ['INVOICE_DB_URL'],
  url: null,
  headers: [],
  include: ['list_invoices', 'get_invoice'],
  exclude: [],
  timeoutS: 30,
};

describe('hermesMcpEntry', () => {
  it('gives a stdio server ${NAME} references, never values', () => {
    expect(hermesMcpEntry(stdio)).toEqual({
      command: 'invoice-db-mcp',
      args: ['--verbose'],
      env: { INVOICE_DB_URL: '${INVOICE_DB_URL}' },
      tools: { include: ['list_invoices', 'get_invoice'] },
      timeout: 30,
    });
  });

  it('leaves out empty filters: to Hermes `include: []` offers no tool', () => {
    expect(hermesMcpEntry({ ...stdio, include: [] })).not.toHaveProperty('tools');
    expect(hermesMcpEntry({ ...stdio, include: [], exclude: ['delete_*'] })).toMatchObject({
      tools: { exclude: ['delete_*'] },
    });
  });

  it('points an http server at the egress gateway, with no headers', () => {
    const entry = hermesMcpEntry({
      ...stdio,
      name: 'vendor-api',
      transport: 'http',
      command: null,
      args: [],
      envNames: [],
      url: 'https://vendor-api.example.com/mcp',
      headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }],
      include: [],
    });
    expect(entry).toEqual({ url: 'http://egress:8080/mcp/vendor-api', timeout: 30 });
    expect(JSON.stringify(entry)).not.toContain('VENDOR_API_TOKEN');
  });
});

describe('toolOffered', () => {
  it('follows Hermes: include is a whitelist and wins over exclude', () => {
    const filters = { include: ['list_*', 'get_invoice'], exclude: ['list_invoices'] };
    expect(toolOffered('list_invoices', filters)).toBe(true);
    expect(toolOffered('get_invoice', filters)).toBe(true);
    expect(toolOffered('delete_invoice', filters)).toBe(false);
  });

  it('offers everything not excluded when there is no include list', () => {
    const filters = { include: [], exclude: ['delete_*', 'update_invoice'] };
    expect(toolOffered('list_invoices', filters)).toBe(true);
    expect(toolOffered('delete_invoice', filters)).toBe(false);
    expect(toolOffered('update_invoice', filters)).toBe(false);
    expect(toolOffered('anything', { include: [], exclude: [] })).toBe(true);
  });

  it('matches exact names literally and globs case-sensitively', () => {
    expect(toolOffered('a.b', { include: ['a.b'], exclude: [] })).toBe(true);
    expect(toolOffered('aXb', { include: ['a.b'], exclude: [] })).toBe(false);
    expect(toolOffered('List_invoices', { include: ['list_*'], exclude: [] })).toBe(false);
  });
});

describe('globToRegExp', () => {
  it('translates fnmatch patterns', () => {
    const cases: Array<[string, string, boolean]> = [
      ['*_radar_*', 'get_radar_image', true],
      ['get_?', 'get_a', true],
      ['get_?', 'get_ab', false],
      ['[abc]_x', 'b_x', true],
      ['[!abc]_x', 'b_x', false],
      ['[!abc]_x', 'd_x', true],
      ['[a-c]1', 'b1', true],
      ['[]]x', ']x', true],
      ['[unclosed', '[unclosed', true],
      ['a+b(c)', 'a+b(c)', true],
      ['*', '', true],
    ];
    for (const [pattern, name, expected] of cases) {
      expect(globToRegExp(pattern).test(name), `${pattern} vs ${name}`).toBe(expected);
    }
  });
});
