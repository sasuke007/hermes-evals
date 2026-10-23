import { describe, expect, it } from 'vitest';
import { isConnectionError } from './migration.service.js';

const withCode = (code: string, message = code) => Object.assign(new Error(message), { code });

describe('isConnectionError', () => {
  it('treats an unreachable or starting Postgres as a connection error', () => {
    expect(isConnectionError(withCode('ECONNREFUSED'))).toBe(true);
    expect(isConnectionError(withCode('ENOTFOUND'))).toBe(true);
    expect(isConnectionError(withCode('57P03', 'the database system is starting up'))).toBe(true);
    expect(isConnectionError(new AggregateError([withCode('ECONNREFUSED')]))).toBe(true);
    expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('treats everything else as a real fault', () => {
    expect(isConnectionError(withCode('28P01', 'password authentication failed'))).toBe(false);
    expect(isConnectionError(withCode('42P01', 'relation does not exist'))).toBe(false);
    expect(isConnectionError(new Error('migration failed'))).toBe(false);
    expect(isConnectionError('ECONNREFUSED')).toBe(false);
  });
});
