import { describe, expect, it } from 'vitest';
import { endpointOf, fileTreeText, joinArgs, splitArgs, toolCounts } from '../format';
import { parseCsv, parseInline, parseMarkdown } from '../markdown';
import { MCP_INVOICE_DB, MCP_VENDOR_API } from '@/fixtures/resources';

describe('resource formats', () => {
  it('draws the upload file tree as the board does', () => {
    expect(
      fileTreeText('invoice-method', [
        { path: 'SKILL.md', sizeBytes: 2150 },
        { path: 'checklist.md', sizeBytes: 1434 },
        { path: 'examples/reconcile.py', sizeBytes: 10035 },
        { path: 'examples/sample.csv', sizeBytes: 5018 },
      ]),
    ).toBe(
      [
        'invoice-method/',
        '├── SKILL.md                 2.1 KB',
        '├── checklist.md             1.4 KB',
        '├── examples/reconcile.py    9.8 KB',
        '└── examples/sample.csv      4.9 KB',
      ].join('\n'),
    );
  });

  it('splits and joins arguments, keeping quoted spaces', () => {
    expect(splitArgs('invoice-db-mcp --db "my file.db"  -v')).toEqual([
      'invoice-db-mcp',
      '--db',
      'my file.db',
      '-v',
    ]);
    expect(joinArgs(['invoice-db-mcp', '--db', 'my file.db'])).toBe(
      'invoice-db-mcp --db "my file.db"',
    );
    expect(splitArgs('   ')).toEqual([]);
    expect(endpointOf(MCP_INVOICE_DB)).toBe('npx invoice-db-mcp');
    expect(endpointOf(MCP_VENDOR_API)).toBe('https://vendor-api.example.com/mcp');
    expect(toolCounts(MCP_INVOICE_DB.lastTest)).toEqual({ total: 4, included: 2 });
    expect(toolCounts({ status: 'untested' })).toBeNull();
  });
});

describe('markdown subset', () => {
  it('parses the skill body into blocks, never HTML', () => {
    const blocks = parseMarkdown(
      '# Invoice method\n\nBefore computing any total.\n\n1. Load with `read_file`.\n2. Find **duplicates**.\n\n- a\n- b\n\n```\ncode <b>\n```\n<script>x</script>',
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'code',
      'paragraph',
    ]);
    expect(blocks[2]).toMatchObject({ ordered: true, start: 1 });
    expect(blocks[4]).toEqual({ kind: 'code', text: 'code <b>' });
    expect(blocks[5]).toEqual({
      kind: 'paragraph',
      inline: [{ kind: 'text', text: '<script>x</script>' }],
    });
    expect(parseInline('Load `read_file`, not **head**.')).toEqual([
      { kind: 'text', text: 'Load ' },
      { kind: 'code', text: 'read_file' },
      { kind: 'text', text: ', not ' },
      { kind: 'bold', text: 'head' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('reads CSV with quoted fields', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\r\n3,4')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['3', '4'],
    ]);
    expect(parseCsv('a\n1\n2\n3', 2)).toEqual([['a'], ['1']]);
  });
});
