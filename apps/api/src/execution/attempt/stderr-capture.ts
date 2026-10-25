/**
 * The trial's stderr (plan 8.3): every byte goes to <trial root>/stderr.log,
 * beside the home and workspace and outside the trial's view, readable by the
 * worker only. The attempt keeps the last 40 lines, with every secret value
 * replaced by `<from env NAME>` before the lines are cut, so a value the cut
 * would split is still caught.
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { ByteTail } from '../../sandbox/streams.js';
import type { Redactor } from './redaction.js';

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
  constructor(path: string) {
    this.file = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    // A full disk or a vanished directory loses the file, never the tail or the run.
    this.file.on('error', (err) => (this.fileError = err));
  }

  get bytes(): number {
    return this.total;
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
}
