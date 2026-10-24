/**
 * What a document is, for the library list: its media type, and a short
 * label such as "PDF · 6 pages", "Markdown · 120 lines" or
 * "CSV · 48 rows · 8 columns" (rows exclude the header line, as the suite
 * fixtures count them). When the content cannot be counted cheaply the
 * label falls back to the size: "PDF · 1.2 MB".
 *
 * The browser's declared type is a hint only: the extension decides first,
 * then the first bytes, and an unknown type is application/octet-stream.
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { parse } from 'csv-parse';
import { countOf, formatBytes } from '../skills/format.js';

const BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const MAGIC: [string, Buffer][] = [
  ['application/pdf', Buffer.from('%PDF-')],
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['image/gif', Buffer.from('GIF8')],
];

/** A media type as the browser may send it: `type/subtype`, nothing more. */
const PLAIN_MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

/** The media type stored with a document. */
export function mediaTypeFor(filename: string, head: Uint8Array, declared: string): string {
  const byExtension = BY_EXTENSION[extname(filename).toLowerCase()];
  if (byExtension) return byExtension;
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  for (const [type, magic] of MAGIC) {
    if (bytes.subarray(0, magic.length).equals(magic)) return type;
  }
  const hint = declared.trim().toLowerCase();
  return PLAIN_MEDIA_TYPE.test(hint) && hint !== 'application/octet-stream'
    ? hint
    : 'application/octet-stream';
}

/** Lines in a text file: newlines, plus one for a last line without one. */
export function countLines(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines++;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}

// ---------------------------------------------------------------------------
// PDF pages
// ---------------------------------------------------------------------------

/** At most this much is inflated from object streams in search of the page tree. */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
const MAX_OBJECT_STREAMS = 200;

const LT = 0x3c; // <
const GT = 0x3e; // >
/** How far a dictionary may extend on either side of the key found in it. */
const MAX_DICTIONARY_SPAN = 64 * 1024;
/** Page tree nodes looked at; a real tree has few, a hostile file could have millions. */
const MAX_PAGE_NODES = 1000;

/**
 * The text of the dictionary that encloses position `at`, with nested
 * dictionaries left out, so a /Count inside /Resources is not read as the
 * page count. Null when `at` is not inside a dictionary within reach.
 */
function enclosingDictionary(text: string, at: number): string | null {
  const isPair = (i: number, code: number) =>
    text.charCodeAt(i) === code && text.charCodeAt(i + 1) === code;
  let depth = 0;
  let start = -1;
  for (let i = at - 2; i >= Math.max(0, at - MAX_DICTIONARY_SPAN); i--) {
    if (isPair(i, GT)) {
      depth++;
      i--;
    } else if (isPair(i, LT)) {
      if (depth === 0) {
        start = i + 2;
        break;
      }
      depth--;
      i--;
    }
  }
  if (start < 0) return null;
  const parts: string[] = [];
  let from = start;
  depth = 0;
  for (let i = start; i < Math.min(text.length - 1, at + MAX_DICTIONARY_SPAN); i++) {
    if (isPair(i, LT)) {
      if (depth === 0) parts.push(text.slice(from, i));
      depth++;
      i++;
    } else if (isPair(i, GT)) {
      if (depth === 0) {
        parts.push(text.slice(from, i));
        return parts.join(' ');
      }
      depth--;
      i++;
      if (depth === 0) from = i + 1;
    }
  }
  return null;
}

/** The largest /Count of a /Type /Pages node in `text`: the root of the page tree. */
function pageTreeCount(text: string): number | null {
  let best: number | null = null;
  let nodes = 0;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b/g)) {
    if (++nodes > MAX_PAGE_NODES) break;
    const dictionary = enclosingDictionary(text, match.index);
    const count = dictionary && /\/Count\s+(\d+)/.exec(dictionary);
    if (count) best = Math.max(best ?? 0, Number(count[1]));
  }
  return best;
}

/** Inflated contents of the PDF's compressed object streams (PDF 1.5+ may keep the page tree there). */
function* objectStreams(pdf: Buffer, text: string): Generator<string> {
  let inflated = 0;
  let seen = 0;
  for (const match of text.matchAll(/\/Type\s*\/ObjStm\b/g)) {
    if (++seen > MAX_OBJECT_STREAMS || inflated >= MAX_INFLATED_BYTES) return;
    const dictionary = enclosingDictionary(text, match.index) ?? '';
    if (!/\/Filter\s*\/FlateDecode\b/.test(dictionary)) continue;
    const keyword = /stream\r?\n/g;
    keyword.lastIndex = match.index;
    const opening = keyword.exec(text);
    if (!opening) continue;
    const begin = opening.index + opening[0].length;
    const end = text.indexOf('endstream', begin);
    if (end < 0) continue;
    try {
      const data = inflateSync(pdf.subarray(begin, end), {
        maxOutputLength: MAX_INFLATED_BYTES - inflated,
      });
      inflated += data.length;
      yield data.toString('latin1');
    } catch {
      // A damaged or unusual stream: skip it.
    }
  }
}

/**
 * The page count of a PDF when it is cheap to find: the linearization hint,
 * else the root of the page tree in plain objects or in object streams.
 * Null for anything else (encrypted, damaged or unusual files).
 */
export function countPdfPages(pdf: Buffer): number | null {
  if (!pdf.subarray(0, 1024).includes('%PDF-')) return null;
  const text = pdf.toString('latin1');
  const linearized = /\/Linearized\b[^>]*?\/N\s+(\d+)/.exec(text.slice(0, 4096));
  if (linearized) return Number(linearized[1]);
  const plain = pageTreeCount(text);
  if (plain !== null) return plain;
  let best: number | null = null;
  for (const stream of objectStreams(pdf, text)) {
    const count = pageTreeCount(stream);
    if (count !== null) best = Math.max(best ?? 0, count);
  }
  return best;
}

// ---------------------------------------------------------------------------
// CSV shape
// ---------------------------------------------------------------------------

/** Data rows (header excluded) and header columns, or null when it does not parse. */
export async function csvShape(
  path: string,
  delimiter: string,
): Promise<{ rows: number; columns: number } | null> {
  const parser = parse({
    bom: true,
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
  });
  const source = createReadStream(path);
  source.on('error', (err) => parser.destroy(err));
  source.pipe(parser);
  let records = 0;
  let columns = 0;
  try {
    for await (const record of parser) {
      if (records === 0) columns = (record as unknown[]).length;
      records++;
    }
  } catch {
    return null;
  } finally {
    source.destroy();
  }
  return { rows: Math.max(records - 1, 0), columns };
}

// ---------------------------------------------------------------------------
// The label
// ---------------------------------------------------------------------------

/** The kind word of a label for a media type: "PDF", "CSV", or the extension. */
function kindOf(mediaType: string, filename: string): string {
  const kinds: Record<string, string> = {
    'application/pdf': 'PDF',
    'text/markdown': 'Markdown',
    'text/plain': 'Text',
    'application/yaml': 'YAML',
    'text/csv': 'CSV',
    'text/tab-separated-values': 'TSV',
    'application/json': 'JSON',
  };
  const ext = extname(filename).slice(1);
  return kinds[mediaType] ?? (/^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toUpperCase() : 'File');
}

/** A label from type and size alone, without reading the content: "PDF · 1.2 MB". */
export const sizeTypeLabel = (mediaType: string, size: number, filename: string): string =>
  `${kindOf(mediaType, filename)} · ${formatBytes(size)}`;

/** The label for the document at `path` (its stored blob or the upload). */
export async function documentTypeLabel(
  path: string,
  mediaType: string,
  size: number,
  filename: string,
): Promise<string> {
  const kind = kindOf(mediaType, filename);
  const lines = async () => `${kind} · ${countOf(countLines(await readFile(path)), 'line')}`;
  switch (mediaType) {
    case 'application/pdf': {
      const pages = countPdfPages(await readFile(path));
      return pages !== null && pages > 0
        ? `PDF · ${countOf(pages, 'page')}`
        : sizeTypeLabel(mediaType, size, filename);
    }
    case 'text/markdown':
    case 'text/plain':
    case 'application/yaml':
      return lines();
    case 'text/csv':
    case 'text/tab-separated-values': {
      const shape = await csvShape(path, mediaType === 'text/csv' ? ',' : '\t');
      return shape
        ? `${kind} · ${countOf(shape.rows, 'row')} · ${countOf(shape.columns, 'column')}`
        : sizeTypeLabel(mediaType, size, filename);
    }
    default:
      return sizeTypeLabel(mediaType, size, filename);
  }
}
