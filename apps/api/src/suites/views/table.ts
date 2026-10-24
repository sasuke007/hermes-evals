/**
 * Fixture descriptions for Task detail: the type label ("CSV · 48 rows ·
 * 8 columns") and the first rows of a tabular file. Pure functions over the
 * file's bytes; the service decides which files are small enough to read.
 */
import { pipeline } from 'node:stream/promises';
import { parse as parseStream } from 'csv-parse';
import { parse } from 'csv-parse/sync';
import type { TablePreview } from '@hermes-evals/shared';

/** Rows a preview shows, after the header. */
export const PREVIEW_ROWS = 10;

export type TabularFormat = 'csv' | 'tsv';

const DELIMITERS: Record<TabularFormat, string> = { csv: ',', tsv: '\t' };

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** csv or tsv by extension, or null for a file that is not tabular. */
export function tabularFormatOf(path: string): TabularFormat | null {
  const ext = extensionOf(path);
  return ext === 'csv' || ext === 'tsv' ? ext : null;
}

/**
 * Header and data records of a CSV or TSV file, or null when it does not
 * parse (unbalanced quotes) or is empty. Rows of uneven length are kept as
 * they are, since a preview should show the file, not repair it.
 */
function records(content: Uint8Array, format: TabularFormat): string[][] | null {
  try {
    const rows = parse(Buffer.from(content), {
      delimiter: DELIMITERS[format],
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][];
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/** The header, the first `maxRows` data rows and the data row count, or null when not parseable. */
export function tablePreview(
  content: Uint8Array,
  format: TabularFormat,
  maxRows = PREVIEW_ROWS,
): TablePreview | null {
  const rows = records(content, format);
  if (!rows) return null;
  const [columns = [], ...data] = rows;
  return { columns, rows: data.slice(0, maxRows), totalRows: data.length };
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

const TEXT_KINDS: Record<string, string> = {
  md: 'Markdown',
  markdown: 'Markdown',
  txt: 'Text',
  yaml: 'YAML',
  yml: 'YAML',
  xml: 'XML',
  html: 'HTML',
};

/**
 * What a fixture is, in a few words: `CSV · 48 rows · 8 columns`,
 * `JSON · 4 keys`, `Markdown · 12 lines`, `PDF`. With `content` null (a file
 * too large to read for a label) only the kind is given.
 */
export function fixtureTypeLabel(path: string, content: Uint8Array | null): string {
  const ext = extensionOf(path);
  const tabular = tabularFormatOf(path);
  if (tabular) {
    const kind = tabular.toUpperCase();
    if (!content) return kind;
    const rows = records(content, tabular);
    if (!rows) return content.length === 0 ? `${kind} · empty` : `${kind} · not parseable`;
    return `${kind} · ${plural(rows.length - 1, 'row')} · ${plural(rows[0]!.length, 'column')}`;
  }
  if (ext === 'json') {
    if (!content) return 'JSON';
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(content));
    } catch {
      return 'JSON · not valid JSON';
    }
    if (Array.isArray(value)) return `JSON · ${plural(value.length, 'item')}`;
    if (value !== null && typeof value === 'object')
      return `JSON · ${plural(Object.keys(value).length, 'key')}`;
    return 'JSON';
  }
  const textKind = TEXT_KINDS[ext];
  if (textKind) return content ? `${textKind} · ${plural(lineCount(content), 'line')}` : textKind;
  return ext ? ext.toUpperCase() : 'File';
}

function lineCount(content: Uint8Array): number {
  const text = new TextDecoder().decode(content);
  if (text.length === 0) return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * tablePreview over a stream, for a file of any size: keeps the header and
 * the first `maxRows` rows and counts the rest without holding them.
 * Resolves null when the file does not parse or is empty.
 */
export async function streamTablePreview(
  source: AsyncIterable<Uint8Array | string>,
  format: TabularFormat,
  maxRows = PREVIEW_ROWS,
): Promise<TablePreview | null> {
  const parser = parseStream({
    delimiter: DELIMITERS[format],
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  });
  // Filled by the consumer below; an object so the types survive the callback.
  const table: { columns: string[] | null; rows: string[][]; totalRows: number } = {
    columns: null,
    rows: [],
    totalRows: 0,
  };
  try {
    // pipeline destroys every stage when one fails, so a parse error leaves nothing running.
    await pipeline(source, parser, async (records: AsyncIterable<string[]>) => {
      for await (const record of records) {
        if (table.columns === null) table.columns = record;
        else {
          if (table.rows.length < maxRows) table.rows.push(record);
          table.totalRows++;
        }
      }
    });
  } catch {
    return null;
  }
  const { columns, rows, totalRows } = table;
  return columns === null ? null : { columns, rows, totalRows };
}
