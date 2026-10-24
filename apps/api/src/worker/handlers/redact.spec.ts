import { describe, expect, it } from 'vitest';
import { redactTruncated, redactValues } from './redact.js';

describe('redactValues', () => {
  it('replaces each value with the marker naming its variable', () => {
    expect(
      redactValues('connecting to file:///data/invoices.csv as s3cr3t-token', {
        INVOICE_DB_URL: 'file:///data/invoices.csv',
        API_TOKEN: 's3cr3t-token',
      }),
    ).toBe('connecting to <from env INVOICE_DB_URL> as <from env API_TOKEN>');
  });

  it('replaces a value that contains another whole, and never rewrites a marker', () => {
    expect(redactValues('key=abc123 short=abc', { LONG: 'abc123', SHORT: 'abc' })).toBe(
      'key=<from env LONG> short=<from env SHORT>',
    );
    // A value that happens to be part of the marker text is not re-matched inside it.
    expect(redactValues('env and value', { A: 'value', B: 'env' })).toBe(
      '<from env B> and <from env A>',
    );
  });

  it('matches the JSON-escaped form a JSON log line carries, and regex characters literally', () => {
    const value = 'p"a\\ss.*';
    expect(redactValues(`{"dsn":${JSON.stringify(value)}}`, { DSN: value })).toBe(
      '{"dsn":"<from env DSN>"}',
    );
    expect(redactValues('pass', { DSN: '.*' })).toBe('pass');
  });

  it('leaves the text alone when there is nothing to hide; empty values are never matched', () => {
    expect(redactValues('nothing here', {})).toBe('nothing here');
    expect(redactValues('nothing here', { EMPTY: '' })).toBe('nothing here');
  });
});

describe('redactTruncated', () => {
  const values = { INVOICE_DB_URL: 'file:///srv/secret-share/invoices.csv' };

  it('masks the start of a value that a "..." cut short', () => {
    expect(redactTruncated('Reads rows from file:///srv/secret-sh...', values)).toBe(
      'Reads rows from <from env INVOICE_DB_URL>...',
    );
  });

  it('redacts whole values as redactValues does, and leaves short or unrelated endings alone', () => {
    expect(redactTruncated(`at ${values.INVOICE_DB_URL}...`, values)).toBe(
      'at <from env INVOICE_DB_URL>...',
    );
    expect(redactTruncated('Lists the invoices fil...', values)).toBe('Lists the invoices fil...');
    expect(redactTruncated('nothing...', {})).toBe('nothing...');
  });
});
