import { describe, expect, it } from 'vitest';
import { SecretRowSchema } from '@hermes-evals/shared';
import {
  checkedWhen,
  NO_WORKER,
  secretRows,
  type SecretReferencingServer,
  type WorkerPresence,
} from './presence.js';

const invoiceDb: SecretReferencingServer = {
  id: 'mcp_invoice',
  name: 'invoice-db',
  transport: 'stdio',
  envNames: ['INVOICE_DB_URL', 'SHARED_TOKEN'],
  headers: [],
};
const vendorApi: SecretReferencingServer = {
  id: 'mcp_vendor',
  name: 'vendor-api',
  transport: 'http',
  envNames: [],
  headers: [
    { header: 'X-Tenant', env: 'SHARED_TOKEN' },
    { header: 'Authorization', env: 'VENDOR_API_TOKEN' },
  ],
};
const ledger: SecretReferencingServer = {
  id: 'mcp_ledger',
  name: 'ledger',
  transport: 'stdio',
  envNames: ['INVOICE_DB_URL'],
  headers: [],
};

const started = new Date('2026-10-24T09:00:00.000Z');
const worker = (over: Partial<WorkerPresence> = {}): WorkerPresence => ({
  envNames: ['INVOICE_DB_URL', 'PATH'],
  egressEnvNames: ['VENDOR_API_TOKEN', 'SHARED_TOKEN'],
  startedAt: started,
  lastHeartbeatAt: new Date('2026-10-24T09:05:10.000Z'),
  ...over,
});
const now = new Date('2026-10-24T09:05:12.000Z');

describe('secretRows', () => {
  it('gives one row per name and the service that reads it, with what references it', () => {
    const rows = secretRows([vendorApi, invoiceDb, ledger], worker(), now);
    expect(rows.map((r) => [r.name, r.source, r.exposure, r.set])).toEqual([
      ['INVOICE_DB_URL', 'worker', 'readable_by_agent', true],
      // Named both ways: the worker and egress must each have it.
      ['SHARED_TOKEN', 'worker', 'readable_by_agent', false],
      ['SHARED_TOKEN', 'egress', 'egress_only', true],
      ['VENDOR_API_TOKEN', 'egress', 'egress_only', true],
    ]);
    expect(rows[0]!.referencedBy).toEqual([
      { kind: 'mcp_server', id: 'mcp_invoice', name: 'invoice-db', via: 'env', header: null },
      { kind: 'mcp_server', id: 'mcp_ledger', name: 'ledger', via: 'env', header: null },
    ]);
    expect(rows[2]!.referencedBy).toEqual([
      {
        kind: 'mcp_server',
        id: 'mcp_vendor',
        name: 'vendor-api',
        via: 'header',
        header: 'X-Tenant',
      },
    ]);
    for (const row of rows) {
      expect(SecretRowSchema.parse(row)).toEqual(row);
      expect(row.lastCheckedAt).toBe('2026-10-24T09:05:10.000Z');
      expect(row.checkedWhen).toBe('on heartbeat');
    }
  });

  it('reads presence per source: a worker name does not make the egress row set', () => {
    const rows = secretRows(
      [vendorApi],
      worker({ envNames: ['VENDOR_API_TOKEN'], egressEnvNames: [] }),
      now,
    );
    expect(rows.map((r) => r.set)).toEqual([false, false]);
  });

  it('marks every row not set when no worker is connected, checked now', () => {
    const rows = secretRows([invoiceDb, vendorApi], null, now);
    expect(rows.every((r) => !r.set)).toBe(true);
    expect(new Set(rows.map((r) => r.checkedWhen))).toEqual(new Set([NO_WORKER]));
    expect(new Set(rows.map((r) => r.lastCheckedAt))).toEqual(new Set([now.toISOString()]));
    for (const row of rows) SecretRowSchema.parse(row);
  });

  it('lists a server once per name when two of its versions in use both reference it', () => {
    const v1 = { ...invoiceDb, envNames: ['INVOICE_DB_URL'] };
    const v2 = { ...invoiceDb, envNames: ['INVOICE_DB_URL', 'INVOICE_DB_PATH'] };
    const rows = secretRows([v2, v1], worker(), now);
    expect(rows.map((r) => [r.name, r.referencedBy.map((ref) => ref.name)])).toEqual([
      ['INVOICE_DB_PATH', ['invoice-db']],
      ['INVOICE_DB_URL', ['invoice-db']],
    ]);
  });

  it('has no rows when no server references a secret', () => {
    expect(secretRows([{ ...invoiceDb, envNames: [] }], worker(), now)).toEqual([]);
  });
});

describe('checkedWhen', () => {
  it('says whether the names were read at start or on a later heartbeat', () => {
    expect(checkedWhen(worker({ lastHeartbeatAt: started }))).toBe('at worker start');
    expect(checkedWhen(worker())).toBe('on heartbeat');
    expect(checkedWhen(null)).toBe(NO_WORKER);
  });
});
