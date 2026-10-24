import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMcpTestOutput } from './mcp-test-output.js';

/**
 * `hermes mcp test` in the trial image, captured 24 Oct 2026 with
 * `docker run --network none` (see __fixtures__/hermes-mcp-test):
 * - invoice-db-passed: the sample server with INVOICE_DB_URL set;
 * - invoice-db-missing-env: the same server without it (it exits at start);
 * - missing-command: a command that is not installed;
 * - odd-tools: a server whose tools have a name past the column, a
 *   multi-line description, none at all, non-ASCII text and dots in the name.
 */
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '__fixtures__', 'hermes-mcp-test', name), 'utf8');

/** As the trial runner delivers stdout: one line per call, blank lines dropped, joined with \n. */
const asDelivered = (text: string): string =>
  text
    .split('\n')
    .filter((line) => line.length > 0)
    .join('\n');

const INVOICE_TOOLS = [
  {
    name: 'list_invoices',
    description: 'List invoices, optionally only those with a status (ope...',
  },
  { name: 'get_invoice', description: 'Get one invoice by its number, e.g. INV-1002.' },
  {
    name: 'update_invoice',
    description: 'Change one field of an invoice. Sample server: reports ...',
  },
  {
    name: 'delete_invoice',
    description: 'Delete an invoice. Sample server: reports the deletion ...',
  },
];

describe('parseMcpTestOutput', () => {
  it('reads a passing test: start time and every tool with its description', () => {
    expect(parseMcpTestOutput(fixture('invoice-db-passed.stdout.txt'))).toEqual({
      connectedMs: 1171,
      discovered: 4,
      tools: INVOICE_TOOLS,
      failure: null,
    });
  });

  it('reads the text the same way as the trial runner delivers it, with CRLF or colour', () => {
    const text = fixture('invoice-db-passed.stdout.txt');
    const expected = parseMcpTestOutput(text);
    expect(parseMcpTestOutput(asDelivered(text))).toEqual(expected);
    expect(parseMcpTestOutput(text.replaceAll('\n', '\r\n'))).toEqual(expected);
    const coloured = text
      .replace('✓ Connected', '\u001b[32m✓\u001b[0m Connected')
      .replace('list_invoices', '\u001b[32mlist_invoices\u001b[0m');
    expect(parseMcpTestOutput(coloured).connectedMs).toBe(1171);
  });

  it('reads a failure: elapsed seconds and the reason', () => {
    expect(parseMcpTestOutput(fixture('invoice-db-missing-env.stdout.txt'))).toEqual({
      connectedMs: null,
      discovered: null,
      tools: null,
      failure: { elapsedS: 9.2, reason: 'Connection closed' },
    });
    expect(parseMcpTestOutput(fixture('missing-command.stdout.txt')).failure).toEqual({
      elapsedS: 0.8,
      reason: "missing executable 'no-such-mcp-server'",
    });
  });

  it('keeps a long name, a multi-line description, an empty one and non-ASCII text apart', () => {
    for (const text of [
      fixture('odd-tools.stdout.txt'),
      asDelivered(fixture('odd-tools.stdout.txt')),
    ]) {
      expect(parseMcpTestOutput(text)).toEqual({
        connectedMs: 1114,
        discovered: 4,
        tools: [
          {
            name: 'a_very_long_tool_name_that_goes_past_the_column_width',
            // Blank lines inside a description are dropped like any other.
            description: 'First line of a docstring.\nArgs:\n    x: a number that ...',
          },
          { name: 'no_description', description: null },
          {
            name: 'unicode_desc',
            description: 'Ünïcödé — and a tab\there and    many   spaces',
          },
          { name: 'dotted.name-with-dash', description: 'short' },
        ],
        failure: null,
      });
    }
  });

  it('gives no tool list when the lines do not add up to the count Hermes printed', () => {
    const text = fixture('invoice-db-passed.stdout.txt');
    expect(
      parseMcpTestOutput(text.replace('Tools discovered: 4', 'Tools discovered: 5')).tools,
    ).toBeNull();
    // A line that is not a tool line before the first tool cannot be placed.
    expect(
      parseMcpTestOutput(text.replace('    list_invoices', 'noise\n    list_invoices')).tools,
    ).toBeNull();
    // A name squeezed against its description is not the layout Hermes prints.
    expect(parseMcpTestOutput(text.replace(/get_invoice +/, 'get_invoice ')).tools).toBeNull();
  });

  it('reads a server with no tools as an empty list', () => {
    const text = "\n  Testing 'empty'...\n  ✓ Connected (900ms)\n  ✓ Tools discovered: 0\n\n";
    expect(parseMcpTestOutput(text)).toEqual({
      connectedMs: 900,
      discovered: 0,
      tools: [],
      failure: null,
    });
  });

  it('finds nothing in output that is not from hermes mcp test', () => {
    expect(parseMcpTestOutput('')).toEqual({
      connectedMs: null,
      discovered: null,
      tools: null,
      failure: null,
    });
    expect(parseMcpTestOutput('Traceback (most recent call last):\n  File "x"').tools).toBeNull();
  });
});
