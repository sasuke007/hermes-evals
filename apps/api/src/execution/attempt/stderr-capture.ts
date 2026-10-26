/**
 * The trial's stderr (plan 8.3): every byte goes to <trial root>/stderr.log,
 * beside the home and workspace and outside the trial's view, readable by the
 * worker only. The attempt keeps the last 40 lines, with every secret value
 * replaced by `<from env NAME>` before the lines are cut, so a value the cut
 * would split is still caught.
 *
 * The inspector's "Full log" (Phase 7, GET /runs/:id/attempts/:n/stderr)
 * reads the log's end as the runner stores it at the end of the attempt
 * (logEnd): the whole log, or its last ATTEMPT_STDERR_MAX_BYTES cut at a
 * line start, redacted the same way. The API has no access to the trials
 * volume and holds none of the values, so the worker, which holds both,
 * makes the copy.
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { ATTEMPT_STDERR_MAX_BYTES } from '@hermes-evals/shared';
import { ByteTail } from '../../sandbox/streams.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { Redactor } from './redaction.js';

/** The end of stderr.log the API serves: redacted text and the whole log's size. */
export interface StderrLogEnd {
  /** The whole log, or its last `maxBytes` from a line start, values redacted. */
  text: string;
  /** stderr.log's size on disk. */
  bytes: number;
  /** `<from env NAME>` markers the redaction put in `text`. */
  replaced: number;
}

/** Lines of stderr the attempt keeps. */
export const STDERR_TAIL_LINES = 40;
/** Bytes held in memory to find those lines. */
const TAIL_BYTES = 64 * 1024;
/** Characters kept in all, so one enormous line cannot make the tail huge. */
const TAIL_CHARS = 16 * 1024;

export class StderrCapture {
  private readonly file: WriteStream;
  private readonly tail = new ByteTail(TAIL_BYTES);
  private total = 0;
  private newlines = 0;
  private lastByte = 0x0a;
  private fileError: Error | null = null;

  /** Creates `path`, which must not exist. */
  constructor(private readonly path: string) {
    this.file = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    // A full disk or a vanished directory loses the file, never the tail or the run.
    this.file.on('error', (err) => (this.fileError = err));
  }

  get bytes(): number {
    return this.total;
  }

  /** Whether stderr.log holds every byte pushed: false once a write failed. */
  get complete(): boolean {
    return this.fileError === null;
  }

  /**
   * Lines in stderr.log, a last line without its newline included: the "N"
   * of the inspector's "last 40 of N lines", which cannot read the file.
   */
  get lines(): number {
    return this.newlines + (this.lastByte === 0x0a ? 0 : 1);
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) this.newlines += 1;
    this.lastByte = chunk[chunk.length - 1]!;
    this.tail.push(chunk);
    if (!this.fileError) this.file.write(chunk);
  }

  /** Closes stderr.log; resolves even if the file could not be written. */
  async close(): Promise<void> {
    this.file.end();
    await finished(this.file).catch(() => {});
  }

  /**
   * The last lines, redacted, or null when the trial wrote nothing. Counts the
   * replacements in what is kept on `redactor`.
   */
  tailLines(redactor: Redactor, lines = STDERR_TAIL_LINES): string | null {
    if (this.total === 0) return null;
    const raw = this.tail.text();
    let text = redactor.textUncounted(raw);
    // The held bytes may start mid-line: drop that partial first line.
    if (this.total > TAIL_BYTES) text = text.slice(text.indexOf('\n') + 1);
    const kept = text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .slice(-lines)
      .join('\n')
      .slice(-TAIL_CHARS);
    redactor.count += Math.max(0, redactor.markers(kept) - redactor.markers(raw));
    return kept === '' ? null : kept;
  }

  /**
   * The log's end for the API, read back from stderr.log after close(): the
   * whole log when it fits in `maxBytes` once redacted, else the redacted
   * text's last `maxBytes` from the first line start in them
   * (endFromLineStart; bytes that are not UTF-8 read as U+FFFD). The bytes
   * read start `redactor.longestForm` earlier, so a value the cut would
   * split is still replaced. Null when the trial wrote nothing or the
   * file lost a write. Never counts on `redactor`; `replaced` says how many
   * markers the text gained.
   */
  async logEnd(
    redactor: Redactor,
    maxBytes: number = ATTEMPT_STDERR_MAX_BYTES,
  ): Promise<StderrLogEnd | null> {
    if (this.total === 0 || this.fileError) return null;
    const file = await open(this.path, 'r');
    try {
      const size = (await file.stat()).size;
      if (size === 0) return null;
      // Characters to bytes: a UTF-8 character is at most 4 bytes.
      const start = size <= maxBytes ? 0 : Math.max(0, size - maxBytes - 4 * redactor.longestForm);
      const window = Buffer.alloc(size - start);
      await file.read(window, 0, window.length, start);
      const raw = window.toString('utf8');
      const text = endFromLineStart(redactor.textUncounted(raw), maxBytes, start > 0);
      const replaced = Math.max(0, redactor.markers(text) - redactor.markers(raw));
      return { text, bytes: size, replaced };
    } finally {
      await file.close();
    }
  }
}

/**
 * The redacted text's last `maxBytes`, from the first line start in them.
 * The cut is made on the redacted text, not only on the bytes read: a
 * `<from env NAME>` marker is longer than a short value, so a log within
 * `maxBytes` on disk can be over it once redacted. `midLine` says the text
 * itself starts inside a line (it was read from inside the log). With no
 * line start to move to, the text is kept from the cut, from its first whole
 * character.
 */
function endFromLineStart(redacted: string, maxBytes: number, midLine: boolean): string {
  let kept = Buffer.from(redacted, 'utf8');
  let startsMidLine = midLine;
  if (kept.length > maxBytes) {
    const cut = kept.length - maxBytes;
    startsMidLine = kept[cut - 1] !== 0x0a;
    kept = kept.subarray(cut);
  } else if (!midLine) {
    return redacted;
  }
  if (!startsMidLine) return kept.toString('utf8');
  const newline = kept.indexOf(0x0a);
  if (newline >= 0 && newline < kept.length - 1) return kept.subarray(newline + 1).toString('utf8');
  // No line start: skip the UTF-8 continuation bytes the cut left, which would each read as U+FFFD.
  let first = 0;
  while (first < kept.length && (kept[first]! & 0xc0) === 0x80) first += 1;
  return kept.subarray(first).toString('utf8');
}

/** What the collected event's `stderr_log` holds: the stored end's blob and the whole log's size. */
export interface StoredStderrLog {
  sha256: string;
  bytes: number;
}

/**
 * Stores the log's end (StderrCapture.logEnd) in the blob store for the
 * inspector's "Full log" (Phase 7, GET /runs/:id/attempts/:n/stderr). The
 * tail's replacements were counted on `redactor` already
 * (`tailReplaced`), so only the ones the longer text adds are. Null when
 * there is nothing to store; throws what the read or the store throws.
 */
export async function storeStderrLog(
  stderr: StderrCapture,
  redactor: Redactor,
  blobs: Pick<BlobStore, 'putBuffer'>,
  tailReplaced: number,
): Promise<StoredStderrLog | null> {
  const end = await stderr.logEnd(redactor);
  if (!end) return null;
  const blob = await blobs.putBuffer(Buffer.from(end.text, 'utf8'));
  redactor.count += Math.max(0, end.replaced - tailReplaced);
  return { sha256: blob.sha256, bytes: end.bytes };
}
