/**
 * Decoding a container's log stream. Without a TTY, Docker multiplexes stdout
 * and stderr into frames: an 8-byte header (stream id, three zero bytes, a
 * big-endian length) followed by that many bytes. Frames split lines
 * arbitrarily (json-file splits lines over 16 KB), so stdout is reassembled
 * into lines across frames before Hermes's stream-json is parsed.
 */

export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onStdout: (chunk: Buffer) => void,
    private readonly onStderr: (chunk: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 8) {
      const size = this.pending.readUInt32BE(4);
      if (this.pending.length < 8 + size) return;
      const stream = this.pending[0];
      const payload = this.pending.subarray(8, 8 + size);
      if (stream === 2) this.onStderr(payload);
      else this.onStdout(payload);
      this.pending = this.pending.subarray(8 + size);
    }
  }
}

/** Splits a byte stream into UTF-8 lines; a line can arrive across many chunks. */
export class LineSplitter {
  private pending: Buffer[] = [];
  private pendingSize = 0;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineBytes = 16 * 1024 * 1024,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf(0x0a, start)) >= 0) {
      this.pending.push(chunk.subarray(start, newline));
      this.emit();
      start = newline + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.pendingSize += rest.length;
      // An absurdly long line is cut rather than held in memory forever.
      if (this.pendingSize > this.maxLineBytes) this.emit();
      else this.pending.push(rest);
    }
  }

  /** Emits whatever is left when the stream ends. */
  end(): void {
    if (this.pendingSize > 0 || this.pending.length > 0) this.emit();
  }

  private emit(): void {
    const line = Buffer.concat(this.pending).toString('utf8').replace(/\r$/, '');
    this.pending = [];
    this.pendingSize = 0;
    if (line.length > 0) this.onLine(line);
  }
}

/**
 * Keeps the last `cap` bytes of a stream, so a process that writes without
 * end costs bounded memory. Used for verifier output and MCP test stderr.
 */
export class ByteTail {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.cap) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  /** Bytes held, which can pass `cap` by less than one chunk until text() trims them. */
  get heldBytes(): number {
    return this.size;
  }

  text(): string {
    return utf8Tail(Buffer.concat(this.chunks), this.cap);
  }
}

/** The last `cap` bytes as text, starting on a character boundary. */
export function utf8Tail(bytes: Buffer, cap: number): string {
  let start = Math.max(0, bytes.length - cap);
  // Skip UTF-8 continuation bytes (10xxxxxx) left over from a cut character.
  while (start < bytes.length && start > 0 && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}
