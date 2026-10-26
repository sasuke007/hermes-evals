/**
 * The e2e suite's files at a time (test/support/e2e-workers.ts): sized from
 * the throwaway server's max_connections, and never asking port 5432.
 */
import { describe, expect, it } from 'vitest';
import { e2eWorkers, serverMaxConnections } from './support/e2e-workers.js';

describe('e2e files at a time', () => {
  it('runs 2 on the default 100-connection server and 4 on one allowing 200', () => {
    expect(e2eWorkers(100)).toBe(2);
    expect(e2eWorkers(200)).toBe(4);
    expect(e2eWorkers(1000)).toBe(4);
    expect(e2eWorkers(40)).toBe(1);
    // Not known: what the default server takes.
    expect(e2eWorkers(null)).toBe(2);
  });

  it('never asks the Compose database, nor a missing or unreadable URL', async () => {
    expect(await serverMaxConnections(undefined)).toBeNull();
    expect(await serverMaxConnections('not a url')).toBeNull();
    expect(
      await serverMaxConnections('postgres://hermes:hermes@localhost:5432/hermes_evals'),
    ).toBeNull();
    expect(
      await serverMaxConnections('postgres://hermes:hermes@localhost/hermes_evals'),
    ).toBeNull();
  });

  it('answers null when nothing listens', async () => {
    expect(await serverMaxConnections('postgres://postgres:test@127.0.0.1:9/postgres')).toBeNull();
  });
});
