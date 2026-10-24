import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countLines,
  countPdfPages,
  documentTypeLabel,
  mediaTypeFor,
  sizeTypeLabel,
} from './type-label.js';
import { classicPdf } from '../skills/testing.helper-spec.js';

/** A PDF 1.5 file whose page tree lives in a compressed object stream. */
function objectStreamPdf(pages: number): Buffer {
  const inner = `2 0 << /Type /Pages /Kids [] /Count ${pages} >>`;
  const data = deflateSync(Buffer.from(inner, 'latin1'));
  const head = Buffer.from(
    `%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
    'latin1',
  );
  return Buffer.concat([head, data, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
}

describe('countPdfPages', () => {
  it('reads the root of the page tree, ignoring nested and unrelated /Count keys', () => {
    expect(countPdfPages(classicPdf(6))).toBe(6);
    expect(countPdfPages(classicPdf(1))).toBe(1);
  });

  it('reads the linearization hint and compressed object streams', () => {
    const linearized = Buffer.from(
      '%PDF-1.7\n1 0 obj\n<< /Linearized 1 /L 4096 /N 3 /T 2000 >>\nendobj\n',
      'latin1',
    );
    expect(countPdfPages(linearized)).toBe(3);
    expect(countPdfPages(objectStreamPdf(12))).toBe(12);
  });

  it('gives up on files it cannot count cheaply', () => {
    expect(countPdfPages(Buffer.from('%PDF-1.7\n% nothing here\n'))).toBeNull();
    expect(countPdfPages(Buffer.from('not a pdf /Type /Pages /Count 3'))).toBeNull();
    // Unbalanced dictionaries do not hang or throw.
    expect(
      countPdfPages(Buffer.from(`%PDF-1.4\n${'<< '.repeat(5000)}/Type /Pages /Count 2`)),
    ).toBeNull();
  });
});

describe('mediaTypeFor', () => {
  it('trusts the extension first, then magic bytes, then a plain declared type', () => {
    expect(mediaTypeFor('vendor-policy-v3.pdf', Buffer.alloc(0), 'application/octet-stream')).toBe(
      'application/pdf',
    );
    expect(mediaTypeFor('NOTES.MD', Buffer.alloc(0), '')).toBe('text/markdown');
    expect(mediaTypeFor('scan', Buffer.from('%PDF-1.7'), '')).toBe('application/pdf');
    expect(
      mediaTypeFor('logo', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ''),
    ).toBe('image/png');
    expect(
      mediaTypeFor('data.parquet', Buffer.from('PAR1'), 'application/vnd.apache.parquet'),
    ).toBe('application/vnd.apache.parquet');
    expect(mediaTypeFor('x.bin', Buffer.alloc(4), 'text/html; charset=utf-8')).toBe(
      'application/octet-stream',
    );
  });
});

describe('countLines', () => {
  it('counts a last line without a newline', () => {
    expect(countLines(Buffer.from(''))).toBe(0);
    expect(countLines(Buffer.from('one'))).toBe(1);
    expect(countLines(Buffer.from('one\ntwo\n'))).toBe(2);
    expect(countLines(Buffer.from('one\r\ntwo'))).toBe(2);
  });
});

describe('documentTypeLabel', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'type-label-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function label(name: string, content: Buffer | string, mediaType: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, content);
    return documentTypeLabel(path, mediaType, Buffer.byteLength(content), name);
  }

  it('labels the formats the library shows, worded like the fixtures', async () => {
    expect(await label('vendor-policy-v3.pdf', classicPdf(6), 'application/pdf')).toBe(
      'PDF · 6 pages',
    );
    const header = 'invoice_no,vendor_name,invoice_date,due_date,amount,currency,po_number,status';
    const rows = Array.from({ length: 48 }, (_, i) => `INV-${i},"Fjord, AS",d,d,1.00,EUR,PO,open`);
    expect(await label('invoices.csv', `${[header, ...rows].join('\n')}\n`, 'text/csv')).toBe(
      'CSV · 48 rows · 8 columns',
    );
    const markdown = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n');
    expect(await label('notes.md', markdown, 'text/markdown')).toBe('Markdown · 120 lines');
    expect(await label('one.txt', 'single', 'text/plain')).toBe('Text · 1 line');
    expect(await label('sheet.tsv', 'a\tb\n1\t2\n', 'text/tab-separated-values')).toBe(
      'TSV · 1 row · 2 columns',
    );
  });

  it('falls back to the size when the content cannot be counted', async () => {
    const opaque = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1300)]);
    expect(await label('scan.pdf', opaque, 'application/pdf')).toBe('PDF · 1.3 KB');
    expect(await label('broken.csv', 'a,"unclosed\n1,2\n', 'text/csv')).toBe('CSV · 16 B');
    expect(await label('data.json', '{"a":1}', 'application/json')).toBe('JSON · 7 B');
    expect(await label('model.onnx', Buffer.alloc(2048), 'application/octet-stream')).toBe(
      'ONNX · 2 KB',
    );
    expect(sizeTypeLabel('application/octet-stream', 10, 'README')).toBe('File · 10 B');
  });
});
