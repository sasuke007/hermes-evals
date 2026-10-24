import { describe, expect, it } from 'vitest';
import { attachmentDisposition, contentTypeFor } from './download.js';

describe('contentTypeFor', () => {
  it.each([
    ['invoices.csv', 'text/csv; charset=utf-8'],
    ['data/Policy.JSON', 'application/json; charset=utf-8'],
    ['scan.pdf', 'application/pdf'],
    ['page.html', 'application/octet-stream'],
    ['logo.svg', 'application/octet-stream'],
    ['Makefile', 'application/octet-stream'],
    ['.env', 'application/octet-stream'],
  ])('%s is %s', (path, type) => {
    expect(contentTypeFor(path)).toBe(type);
  });
});

describe('attachmentDisposition', () => {
  it('names the base name, with an ASCII fallback and the exact name encoded', () => {
    expect(attachmentDisposition('fixtures/invoices.csv')).toBe(
      `attachment; filename="invoices.csv"; filename*=UTF-8''invoices.csv`,
    );
    expect(attachmentDisposition('Rechnung "März" (1).csv')).toBe(
      `attachment; filename="Rechnung _M_rz_ (1).csv"; filename*=UTF-8''Rechnung%20%22M%C3%A4rz%22%20%281%29.csv`,
    );
  });
});
