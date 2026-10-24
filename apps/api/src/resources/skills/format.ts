/**
 * Display strings shared by the skill and document endpoints, worded like
 * the web fixtures (apps/web/src/fixtures/resources.ts): "18.2 KB",
 * "4 files", "PDF · 6 pages". Sizes use 1024-byte units, as the fixtures do.
 */

const UNITS = ['KB', 'MB', 'GB'] as const;

/** 512 → "512 B", 18637 → "18.2 KB", 104857600 → "100 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1).replace(/\.0$/, '')} ${UNITS[unit]}`;
}

/** 1 → "1 file", 2000 → "2,000 files". */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`;
}

// oxlint-disable-next-line no-control-regex -- control characters are what is removed
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * The base name of an uploaded file as the browser named it: the last path
 * segment (either separator), without control characters, at most 255 bytes
 * with its extension kept. `fallback` replaces a name that ends up empty,
 * `.` or `..`. The documents table's filename CHECK accepts every result.
 */
export function uploadFileName(original: string, fallback: string): string {
  const base = (original.split(/[/\\]/).pop() ?? '').replace(CONTROL_CHARS, '').trim();
  if (base === '' || base === '.' || base === '..') return fallback;
  if (Buffer.byteLength(base) <= 255) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : '';
  let stem = base.slice(0, base.length - ext.length);
  while (Buffer.byteLength(stem + ext) > 255) stem = stem.slice(0, -1);
  // A cut can split a surrogate pair; drop the lone half.
  return stem.replace(/[\uD800-\uDBFF]$/, '') + ext;
}
