import { describe, expect, it } from 'vitest';
import { McpTestViewSchema } from '@hermes-evals/shared';
import { readTestRecord } from './test-record.js';
import { toMcpTestView } from './views.js';

const times = {
  job_id: 'job-1',
  requested_at: '2026-10-24T09:00:00.000Z',
  finished_at: '2026-10-24T09:00:02.000Z',
};

describe('toMcpTestView', () => {
  it('marks each tool with whether the definition offers it to the agent', () => {
    const view = toMcpTestView(
      {
        status: 'passed',
        ...times,
        started_ms: 1171,
        tools: [
          { name: 'list_invoices', description: 'List invoices' },
          { name: 'get_invoice' },
          { name: 'delete_invoice', description: 'Delete' },
        ],
      },
      { include: [], exclude: ['delete_*'] },
    );
    expect(McpTestViewSchema.parse(view)).toEqual({
      status: 'passed',
      requestedAt: times.requested_at,
      finishedAt: times.finished_at,
      startedMs: 1171,
      tools: [
        { name: 'list_invoices', description: 'List invoices', included: true },
        { name: 'get_invoice', description: null, included: true },
        { name: 'delete_invoice', description: 'Delete', included: false },
      ],
    });
  });

  it('fills the optional fields of a failed test', () => {
    const view = toMcpTestView(
      {
        status: 'failed',
        ...times,
        error: 'INVOICE_DB_URL is not set',
        missing_secret_names: ['INVOICE_DB_URL'],
      },
      { include: [], exclude: [] },
    );
    expect(McpTestViewSchema.parse(view)).toEqual({
      status: 'failed',
      requestedAt: times.requested_at,
      finishedAt: times.finished_at,
      startedMs: null,
      error: 'INVOICE_DB_URL is not set',
      exitCode: null,
      stderrTail: '',
      missingSecretNames: ['INVOICE_DB_URL'],
    });
    expect(
      toMcpTestView(
        {
          status: 'failed',
          ...times,
          error: 'x',
          missing_secret_names: [],
          exit_code: 1,
          stderr_tail: 'boom',
          started_ms: 40,
        },
        { include: [], exclude: [] },
      ),
    ).toMatchObject({ exitCode: 1, stderrTail: 'boom', startedMs: 40 });
  });

  it('shows untested and running as they are', () => {
    expect(toMcpTestView({ status: 'untested' }, { include: [], exclude: [] })).toEqual({
      status: 'untested',
    });
    expect(
      toMcpTestView(
        { status: 'running', job_id: 'j', requested_at: times.requested_at },
        { include: [], exclude: [] },
      ),
    ).toEqual({ status: 'running', requestedAt: times.requested_at });
  });
});

describe('readTestRecord', () => {
  it('reads a stored record and treats anything unreadable as untested', () => {
    expect(
      readTestRecord({ status: 'running', job_id: 'j', requested_at: times.requested_at }),
    ).toMatchObject({
      status: 'running',
    });
    expect(readTestRecord({ status: 'exploded' })).toEqual({ status: 'untested' });
    expect(readTestRecord(null)).toEqual({ status: 'untested' });
  });
});
