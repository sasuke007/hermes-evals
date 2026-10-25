/**
 * How numbers, times and ids are written on screen (Main › Type scale and Density): signed
 * differences always carry their sign with a true minus (+0.217, −0.040, 0.000); durations are
 * 52 s, 4m 12s, 1h 03m; money is $0.98; token counts are grouped (14,200); a missing value is
 * an en dash, set in --text-3 by the caller. Every page formats through these, so the same
 * value reads the same everywhere.
 */

/** What a missing value shows (the caller sets it in text-text-3). */
export const MISSING = '–';

const isNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** −0.040 with U+2212, never a hyphen. */
function minus(text: string): string {
  return text.replace(/^-/, '−');
}

/** A difference or bound: +0.217, −0.040, 0.000 (three decimals by default). */
export function formatSigned(value: number | null | undefined, digits = 3): string {
  if (!isNumber(value)) return MISSING;
  const fixed = value.toFixed(digits);
  // -0.0004 rounds to "-0.000": a zero carries no sign.
  if (Number(fixed) === 0) return (0).toFixed(digits);
  return value > 0 ? `+${fixed}` : minus(fixed);
}

/** A rate from 0 to 1: three decimals in statistics, two in the grid. */
export function formatRate(value: number | null | undefined, digits = 3): string {
  return isNumber(value) ? value.toFixed(digits) : MISSING;
}

/** Seconds as 52 s, 4m 12s or 1h 03m. */
export function formatDuration(seconds: number | null | undefined): string {
  if (!isNumber(seconds)) return MISSING;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** US dollars: $0.98 (cents), or more decimals for a figure under a cent ($0.0042). */
export function formatUsd(value: number | null | undefined): string {
  if (!isNumber(value)) return MISSING;
  if (value !== 0 && Math.abs(value) < 0.01) return `$${value.toPrecision(2)}`;
  return minus(`$${value.toFixed(2)}`.replace('$-', '-$'));
}

/** A count with grouping: 14,200. */
export function formatCount(value: number | null | undefined): string {
  return isNumber(value) ? Math.round(value).toLocaleString('en-US') : MISSING;
}

/** A count and its noun: "1 task", "12 tasks", "2,000 files", "3 repetitions". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * A size in 1024-byte units with one decimal, dropped when it is 0: 812 B, 7.6 KB, 214 KB,
 * 72.4 MB. The API writes the sizes it sends the same way (resources/skills/format.ts), so a
 * size the browser measures reads like one the API labels.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!isNumber(bytes)) return MISSING;
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1).replace(/\.0$/, '')} ${BYTE_UNITS[unit]}`;
}

/**
 * A Hermes revision as people read it: a bare 40-character commit becomes its first 7
 * characters, and "hermes-agent v0.22.4 @ <commit>" keeps its prefix with the short commit.
 */
export function shortRevision(revision: string): string {
  return revision.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1');
}

/**
 * A sha256 with its head and tail, as file and config hashes are shown:
 * sha256:51e0a9c3…0d17 (`head` hex characters, 12 in the upload checks). A short value is
 * shown whole.
 */
export function formatSha256(hash: string, head = 8): string {
  const hex = hash.replace(/^sha256:/, '');
  if (hex.length <= head + 4) return `sha256:${hex}`;
  return `sha256:${hex.slice(0, head)}…${hex.slice(-4)}`;
}

/** A sha256 shown as a tag: the first 7 hex characters ("sha256:" dropped). */
export function shortHash(hash: string, length = 7): string {
  return hash.replace(/^sha256:/, '').slice(0, length);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

function toDate(value: string | number | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 15:23:42 in local time. */
export function formatClock(value: string | number | Date | null | undefined): string {
  const d = value === null || value === undefined ? null : toDate(value);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : MISSING;
}

/** 23 Oct 15:02 in local time. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = value === null || value === undefined ? null : toDate(value);
  if (!d) return MISSING;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 23 Oct 15:41:07 in local time: when a run started or a self-check ran, to the second. */
export function formatDateTimeSeconds(value: string | number | Date | null | undefined): string {
  const d = value === null || value === undefined ? null : toDate(value);
  if (!d) return MISSING;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${formatClock(d)}`;
}

/** How long ago: 12 s ago, 2 min ago, 3 h ago, 4 d ago. */
export function formatAgo(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  const d = value === null || value === undefined ? null : toDate(value);
  if (!d) return MISSING;
  const seconds = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
