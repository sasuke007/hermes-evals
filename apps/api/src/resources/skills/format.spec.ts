import { describe, expect, it } from 'vitest';
import { countOf, formatBytes, uploadFileName } from './format.js';
import { contentDisposition } from './http.js';

describe('formatBytes and countOf', () => {
  it('match the fixture wording', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(18637)).toBe('18.2 KB');
    expect(formatBytes(219136)).toBe('214 KB');
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 MB');
    expect(countOf(1, 'file')).toBe('1 file');
    expect(countOf(2000, 'entry', 'entries')).toBe('2,000 entries');
  });
});

describe('uploadFileName', () => {
  it('keeps the base name only, without control characters', () => {
    expect(uploadFileName('../../etc/passwd', 'document')).toBe('passwd');
    expect(uploadFileName('C:\\Users\\me\\vendor-policy-v3.pdf', 'document')).toBe(
      'vendor-policy-v3.pdf',
    );
    expect(uploadFileName('re\u0000port\n.md', 'document')).toBe('report.md');
    expect(uploadFileName('résumé.pdf', 'document')).toBe('résumé.pdf');
  });

  it('replaces names that end up empty, . or ..', () => {
    for (const name of ['', '   ', '.', '..', 'dir/', 'a/..']) {
      expect(uploadFileName(name, 'document'), name).toBe('document');
    }
  });

  it('cuts long names to 255 bytes, keeping the extension and whole characters', () => {
    const cut = uploadFileName(`${'é'.repeat(200)}.pdf`, 'document');
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(255);
    expect(cut.endsWith('é.pdf')).toBe(true);
    const emoji = uploadFileName(`${'😀'.repeat(100)}.md`, 'document');
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(255);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('contentDisposition', () => {
  it('sends an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('inline', 'vendor-policy-v3.pdf')).toBe(
      `inline; filename="vendor-policy-v3.pdf"; filename*=UTF-8''vendor-policy-v3.pdf`,
    );
    expect(contentDisposition('attachment', 'résumé "v2".md')).toBe(
      `attachment; filename="r_sum_ _v2_.md"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.md`,
    );
  });
});
