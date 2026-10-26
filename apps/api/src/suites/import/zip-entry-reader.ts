/**
 * Reading the entries of a suite zip whose central directory passed the
 * checks (./zip-entries.ts): each entry's bytes are counted as they inflate,
 * against the file cap and the zip's running total, so a zip whose headers
 * understate its sizes is stopped too. A failure to read an entry is an
 * EntryRefused carrying the problem to show; only the platform's own disk
 * errors pass through.
 */
import type { UploadProblem } from '@hermes-evals/shared';
import type { ZipFile } from 'yauzl';
import { formatBytes } from '../../resources/skills/format.js';
import type { BlobRef, BlobStore } from '../../storage/blob-store.js';
import {
  limitsDetail,
  shown,
  SUITE_ZIP_LIMITS,
  tooLarge,
  type SuiteZipLimits,
  type ZipFileEntry,
} from './zip-entries.js';

/** Counts what entries really inflate to, against the file cap and the zip's running total. */
class Meter {
  total = 0;
  constructor(private readonly limits: SuiteZipLimits) {}

  /**
   * `source`'s chunks, refusing a file or a running total over its cap. An
   * error of `source` (a corrupt entry, a size that lies) rejects the
   * iteration, and stopping early destroys `source`.
   */
  async *through(source: AsyncIterable<Buffer>, label: string): AsyncGenerator<Buffer> {
    let size = 0;
    for await (const chunk of source) {
      size += chunk.length;
      this.total += chunk.length;
      if (size > this.limits.maxFileBytes) {
        throw new EntryRefused({
          title: `${label} is over ${formatBytes(this.limits.maxFileBytes)}.`,
          detail: limitsDetail(this.limits),
        });
      }
      if (this.total > this.limits.maxUnpackedBytes) {
        throw new EntryRefused(tooLarge(null, this.limits));
      }
      yield chunk;
    }
  }
}

/** An entry refused while it was read, with the problem to report. */
export class EntryRefused extends Error {
  constructor(readonly problem: UploadProblem) {
    super(problem.title);
  }
}

/** Errors of the platform's own disk, as opposed to errors reading the zip. */
const isFsError = (err: unknown): boolean => {
  const { code, syscall } = err as NodeJS.ErrnoException;
  return typeof code === 'string' && typeof syscall === 'string';
};

/** Reads the zip's entries, metered against `limits` across every call. */
export class EntryReader {
  private readonly meter: Meter;

  constructor(
    private readonly zip: ZipFile,
    limits: SuiteZipLimits = SUITE_ZIP_LIMITS,
  ) {
    this.meter = new Meter(limits);
  }

  get inflatedBytes(): number {
    return this.meter.total;
  }

  /** One entry's bytes, for the small text files read before anything is stored. */
  async read(file: ZipFileEntry): Promise<Buffer> {
    return this.guard(file, async () => {
      const chunks: Buffer[] = [];
      const source = await this.zip.openReadStreamPromise(file.entry);
      for await (const chunk of this.meter.through(source, shown(file.path))) chunks.push(chunk);
      return Buffer.concat(chunks);
    });
  }

  /** One entry streamed into the blob store, hashed on the way. */
  async store(file: ZipFileEntry, blobs: Pick<BlobStore, 'putStream'>): Promise<BlobRef> {
    return this.guard(file, async () => {
      const source = await this.zip.openReadStreamPromise(file.entry);
      return blobs.putStream(this.meter.through(source, shown(file.path)));
    });
  }

  /** Turns a failure to read the entry into EntryRefused; the platform's own errors pass. */
  private async guard<T>(file: ZipFileEntry, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      if (err instanceof EntryRefused) throw err;
      if (isFsError(err)) throw err;
      throw new EntryRefused({
        title: 'Corrupt zip.',
        detail: `${shown(file.path)} could not be unpacked (${(err as Error).message}).`,
      });
    }
  }
}
