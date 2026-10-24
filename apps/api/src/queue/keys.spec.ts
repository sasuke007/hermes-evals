import { describe, expect, it } from 'vitest';
import type { McpServerInput } from '@hermes-evals/shared';
import { canonicalJson, loadSuitesKey, testMcpServerKey } from './queues.js';

const definition: McpServerInput = {
  name: 'invoice-db',
  transport: 'stdio',
  command: 'python3',
  args: ['/opt/mcp/invoice_db.py'],
  envNames: ['INVOICE_DB_PATH'],
  url: null,
  headers: [],
  include: [],
  exclude: [],
  timeoutS: 60,
};

describe('singleton keys', () => {
  it('give load-suites one key per directory and one for a full reload', () => {
    expect(loadSuitesKey({ path: 'invoices-v1' })).toBe('invoices-v1');
    expect(loadSuitesKey({ path: null })).toBe('*');
  });

  it('give a saved MCP test its version id and definition hash, an unsaved one a hash of its definition', () => {
    const hash = 'a'.repeat(64);
    expect(
      testMcpServerKey({
        kind: 'saved',
        mcpServerVersionId: '01J0000000000000000000000',
        definitionHash: hash,
      }),
    ).toBe(`01J0000000000000000000000:${hash}`);
    // An in-place edit changes the hash, so its test is another job.
    expect(
      testMcpServerKey({
        kind: 'saved',
        mcpServerVersionId: '01J0000000000000000000000',
        definitionHash: 'b'.repeat(64),
      }),
    ).not.toBe(`01J0000000000000000000000:${hash}`);
    const key = testMcpServerKey({ kind: 'unsaved', definition });
    expect(key).toMatch(/^unsaved:[0-9a-f]{64}$/);
    // Same definition with its keys in another order: same key.
    const reordered = Object.fromEntries(Object.entries(definition).reverse()) as McpServerInput;
    expect(testMcpServerKey({ kind: 'unsaved', definition: reordered })).toBe(key);
    // Any change to the definition: another key.
    expect(testMcpServerKey({ kind: 'unsaved', definition: { ...definition, args: [] } })).not.toBe(
      key,
    );
  });

  it('write canonical JSON with sorted keys at every level and arrays in order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
  });
});
