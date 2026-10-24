import { describe, expect, it } from 'vitest';
import { TablePreviewSchema } from '@hermes-evals/shared';
import { fixtureTypeLabel, streamTablePreview, tabularFormatOf, tablePreview } from './table.js';

const bytes = (text: string) => Buffer.from(text, 'utf8');

const header = 'invoice_no,vendor_name,invoice_date,due_date,amount,currency,po_number,status';
const csvRows = Array.from(
  { length: 48 },
  (_, i) => `INV-${1000 + i},"Vendor, ${i}",2026-08-02,2026-09-01,${i}.00,EUR,PO-${i},open`,
);
const INVOICES = `﻿${header}\n${csvRows.join('\n')}\n`;

describe('tablePreview', () => {
  it('returns the header, the first 10 rows and the row count', () => {
    const preview = tablePreview(bytes(INVOICES), 'csv');
    expect(TablePreviewSchema.parse(preview)).toEqual(preview);
    expect(preview?.columns).toEqual(header.split(','));
    expect(preview?.rows).toHaveLength(10);
    expect(preview?.rows[0]).toEqual([
      'INV-1000',
      'Vendor, 0',
      '2026-08-02',
      '2026-09-01',
      '0.00',
      'EUR',
      'PO-0',
      'open',
    ]);
    expect(preview?.totalRows).toBe(48);
  });

  it('reads TSV, keeps uneven rows, skips blank lines', () => {
    expect(tablePreview(bytes('a\tb\n1\t2\n\n3\n'), 'tsv', 5)).toEqual({
      columns: ['a', 'b'],
      rows: [['1', '2'], ['3']],
      totalRows: 2,
    });
  });

  it('is null for an empty or unparseable file', () => {
    expect(tablePreview(bytes(''), 'csv')).toBeNull();
    expect(tablePreview(bytes('a,b\n"open,1\n'), 'csv')).toBeNull();
  });
});

describe('fixtureTypeLabel', () => {
  it('describes tabular files by rows and columns', () => {
    expect(fixtureTypeLabel('fixtures/invoices.csv', bytes(INVOICES))).toBe(
      'CSV · 48 rows · 8 columns',
    );
    expect(fixtureTypeLabel('fixtures/x.TSV', bytes('a\tb\n1\t2\n'))).toBe(
      'TSV · 1 row · 2 columns',
    );
    expect(fixtureTypeLabel('fixtures/one.csv', bytes('only\n'))).toBe('CSV · 0 rows · 1 column');
    expect(fixtureTypeLabel('fixtures/empty.csv', bytes(''))).toBe('CSV · empty');
    expect(fixtureTypeLabel('fixtures/bad.csv', bytes('a\n"x\n'))).toBe('CSV · not parseable');
  });

  it('describes JSON by keys or items', () => {
    expect(fixtureTypeLabel('fixtures/policy_terms.json', bytes('{"a":1,"b":2,"c":3,"d":4}'))).toBe(
      'JSON · 4 keys',
    );
    expect(fixtureTypeLabel('fixtures/list.json', bytes('[1]'))).toBe('JSON · 1 item');
    expect(fixtureTypeLabel('fixtures/n.json', bytes('3'))).toBe('JSON');
    expect(fixtureTypeLabel('fixtures/bad.json', bytes('{'))).toBe('JSON · not valid JSON');
  });

  it('counts lines of text files and names other files by extension', () => {
    expect(fixtureTypeLabel('fixtures/notes.md', bytes('# A\n\nb\n'))).toBe('Markdown · 3 lines');
    expect(fixtureTypeLabel('fixtures/a.txt', bytes('one'))).toBe('Text · 1 line');
    expect(fixtureTypeLabel('fixtures/scan.pdf', bytes('%PDF'))).toBe('PDF');
    expect(fixtureTypeLabel('fixtures/Makefile', bytes('x'))).toBe('File');
  });

  it('gives only the kind when the file was too large to read', () => {
    expect(fixtureTypeLabel('fixtures/big.csv', null)).toBe('CSV');
    expect(fixtureTypeLabel('fixtures/big.json', null)).toBe('JSON');
    expect(fixtureTypeLabel('fixtures/big.md', null)).toBe('Markdown');
  });

  it('tabularFormatOf goes by extension', () => {
    expect(tabularFormatOf('a/b.csv')).toBe('csv');
    expect(tabularFormatOf('b.tsv')).toBe('tsv');
    expect(tabularFormatOf('b.json')).toBeNull();
    expect(tabularFormatOf('.csv')).toBeNull();
  });
});

describe('streamTablePreview', () => {
  async function* chunks(text: string, size: number) {
    for (let i = 0; i < text.length; i += size) yield bytes(text.slice(i, i + size));
  }

  it('matches tablePreview however the file is split', async () => {
    const preview = await streamTablePreview(chunks(INVOICES, 7), 'csv');
    expect(preview).toEqual(tablePreview(bytes(INVOICES), 'csv'));
  });

  it('counts every row of a large file and keeps only the first ones', async () => {
    const big = `a,b\n${Array.from({ length: 50_000 }, (_, i) => `${i},x`).join('\n')}\n`;
    const preview = await streamTablePreview(chunks(big, 65_536), 'csv', 3);
    expect(preview).toEqual({
      columns: ['a', 'b'],
      rows: [
        ['0', 'x'],
        ['1', 'x'],
        ['2', 'x'],
      ],
      totalRows: 50_000,
    });
  });

  it('is null for an empty or unparseable stream', async () => {
    expect(await streamTablePreview(chunks('', 1), 'csv')).toBeNull();
    expect(await streamTablePreview(chunks('a,b\n"open,1\n', 3), 'csv')).toBeNull();
  });
});
