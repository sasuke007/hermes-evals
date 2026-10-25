/**
 * The small Markdown subset a skill's files use, parsed into blocks the skill drawer renders
 * with plain elements (never as HTML, so a file cannot inject markup): headings, paragraphs,
 * ordered and bulleted lists, fenced code, and inline `code` and **bold**. Anything else
 * reads as paragraph text.
 */

export type Inline = { kind: 'text' | 'code' | 'bold'; text: string };

export type MarkdownBlock =
  | { kind: 'heading'; level: number; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { kind: 'code'; text: string };

/** `code` and **bold** inside a line; the rest is text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    if (match[1] !== undefined) out.push({ kind: 'code', text: match[1] });
    else out.push({ kind: 'bold', text: match[2] ?? '' });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
    if (list) {
      blocks.push({
        kind: 'list',
        ordered: list.ordered,
        start: list.start,
        items: list.items.map(parseInline),
      });
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trimStart().startsWith('```')) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        code.push(lines[i] ?? '');
        i++;
      }
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        inline: parseInline(heading[2] ?? ''),
      });
      continue;
    }
    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);
    if (ordered || bullet) {
      if (paragraph.length) flush();
      const isOrdered = !!ordered;
      if (list && list.ordered !== isOrdered) flush();
      list ??= { ordered: isOrdered, start: ordered ? Number(ordered[1]) : 1, items: [] };
      list.items.push((ordered ? ordered[2] : bullet?.[1]) ?? '');
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      // A continuation line of the last item.
      const items = list.items;
      items[items.length - 1] = `${items[items.length - 1] ?? ''} ${line.trim()}`;
      continue;
    }
    if (list) flush();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** A small CSV reader for previews: commas, "quoted, fields" and "" escapes. */
export function parseCsv(text: string, maxRows = 200): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if ((field !== '' || row.length) && rows.length < maxRows) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
