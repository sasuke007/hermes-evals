/**
 * Headers of a fixture download. Fixtures are the author's own files, but the
 * API serves them from its own origin, so anything a browser would render as
 * a page (HTML, SVG) goes out as a plain download, and every response is an
 * attachment the browser saves rather than opens.
 */

const TYPES: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  parquet: 'application/vnd.apache.parquet',
};

/** Content-Type by extension; unknown and active types are `application/octet-stream`. */
export function contentTypeFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/**
 * `attachment` with the file's base name: an ASCII fallback (anything outside
 * printable ASCII, quotes and backslashes become `_`) and the exact name in
 * RFC 5987 form for browsers that read it.
 */
export function attachmentDisposition(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1) || 'download';
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
