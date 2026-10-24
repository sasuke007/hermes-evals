/**
 * Saving MCP server definitions on PGlite, with the real migrations and
 * triggers: version 1 with its server, in-place edits, a frozen definition
 * becoming version 2, the rename rule, and which configurations use a server.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { McpServerRowSchema, type McpServerRow } from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { configurations, mcpServers, mcpServerVersions } from '../../database/schema/index.js';
import { definitionHash } from './definition.js';
import { McpServersService } from './mcp-servers.service.js';
import { INVOICE_DB, useInConfiguration, VENDOR_API } from './mcp-testing.support-spec.js';

// PGlite databases are slow to create when every test file runs at once.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('McpServersService', () => {
  let t: TestDatabase;
  let service: McpServersService;

  beforeEach(async () => {
    t = await createTestDatabase();
    service = new McpServersService(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  const versionsOf = (serverId: string) =>
    t.db
      .select()
      .from(mcpServerVersions)
      .where(eq(mcpServerVersions.mcpServerId, serverId))
      .orderBy(mcpServerVersions.version);

  const passedTest = {
    status: 'passed' as const,
    job_id: 'job-1',
    requested_at: '2026-10-24T09:00:00.000Z',
    finished_at: '2026-10-24T09:00:02.000Z',
    started_ms: 1171,
    tools: [{ name: 'list_invoices' }],
  };

  describe('create', () => {
    it('stores the server and its version 1, untested, and returns the row contract', async () => {
      const row = await service.create(INVOICE_DB);
      expect(McpServerRowSchema.parse(row)).toEqual(row);
      expect(row).toMatchObject({
        ...INVOICE_DB,
        version: 1,
        frozen: false,
        usedBy: [],
        lastTest: { status: 'untested' },
      });
      const [server] = await t.db.select().from(mcpServers).where(eq(mcpServers.id, row.id));
      expect(server).toMatchObject({ name: 'invoice-db', latestVersion: 1 });
      const [version] = await versionsOf(row.id);
      expect(version).toMatchObject({
        id: row.versionId,
        definitionHash: definitionHash(INVOICE_DB),
      });
    });

    it('stores an http server with its header pairs', async () => {
      const row = await service.create(VENDOR_API);
      expect(row).toMatchObject({ transport: 'http', headers: VENDOR_API.headers, command: null });
    });

    it('refuses a name another server has, with 409', async () => {
      await service.create(INVOICE_DB);
      const err = await service
        .create({ ...VENDOR_API, name: 'invoice-db' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual({
        statusCode: 409,
        message: 'an MCP server named invoice-db already exists',
      });
      expect(await t.db.select().from(mcpServers)).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('rewrites an unused definition in place and resets its last test', async () => {
      const created = await service.create(INVOICE_DB);
      await t.db
        .update(mcpServerVersions)
        .set({ lastTest: passedTest })
        .where(eq(mcpServerVersions.id, created.versionId));

      const edited = { ...INVOICE_DB, args: ['--read-only'], timeoutS: 45 };
      const row = await service.update(created.id, edited);
      expect(row).toMatchObject({ ...edited, versionId: created.versionId, version: 1 });
      expect(row.lastTest).toEqual({ status: 'untested' });
      const versions = await versionsOf(created.id);
      expect(versions).toHaveLength(1);
      expect(versions[0]!.definitionHash).toBe(definitionHash(edited));
    });

    it('keeps the last test when nothing that matters changed', async () => {
      const created = await service.create({ ...INVOICE_DB, envNames: ['A_URL', 'B_KEY'] });
      await t.db
        .update(mcpServerVersions)
        .set({ lastTest: passedTest })
        .where(eq(mcpServerVersions.id, created.versionId));
      const row = await service.update(created.id, { ...INVOICE_DB, envNames: ['B_KEY', 'A_URL'] });
      expect(row.envNames).toEqual(['B_KEY', 'A_URL']);
      expect(row.lastTest.status).toBe('passed');
      // Saving exactly what is stored changes nothing.
      const again = await service.update(created.id, {
        ...INVOICE_DB,
        envNames: ['B_KEY', 'A_URL'],
      });
      expect(again).toEqual(row);
    });

    it('adds version 2 for a definition a configuration uses; the configuration keeps version 1', async () => {
      const created = await service.create(INVOICE_DB);
      const configurationId = await useInConfiguration(t.db, 'baseline', [created.versionId]);
      const [frozen] = await service.list();
      expect(frozen).toMatchObject({
        frozen: true,
        usedBy: [{ configurationId, name: 'baseline' }],
      });

      // A frozen definition still records its test results.
      await t.db
        .update(mcpServerVersions)
        .set({ lastTest: passedTest })
        .where(eq(mcpServerVersions.id, created.versionId));

      const edited = { ...INVOICE_DB, exclude: [] };
      const row = await service.update(created.id, edited);
      expect(McpServerRowSchema.parse(row)).toEqual(row);
      expect(row).toMatchObject({
        ...edited,
        version: 2,
        frozen: false,
        lastTest: { status: 'untested' },
        // Still on version 1 of the server, so it still uses the server.
        usedBy: [{ configurationId, name: 'baseline' }],
      });
      expect(row.versionId).not.toBe(created.versionId);

      const [v1, v2] = await versionsOf(created.id);
      expect(v1).toMatchObject({
        id: created.versionId,
        exclude: ['delete_*'],
        lastTest: passedTest,
      });
      expect(v1!.frozenAt).not.toBeNull();
      expect(v2).toMatchObject({ id: row.versionId, version: 2, frozenAt: null });
      const [server] = await t.db.select().from(mcpServers).where(eq(mcpServers.id, created.id));
      expect(server!.latestVersion).toBe(2);

      // Version 2 is not frozen, so the next edit rewrites it.
      const third = await service.update(created.id, { ...edited, timeoutS: 90 });
      expect(third).toMatchObject({ versionId: row.versionId, version: 2, timeoutS: 90 });
      expect(await versionsOf(created.id)).toHaveLength(2);
    });

    it('treats a reorder of a frozen definition as no change', async () => {
      const created = await service.create({
        ...INVOICE_DB,
        include: ['get_invoice', 'list_invoices'],
      });
      await useInConfiguration(t.db, 'baseline', [created.versionId]);
      const row = await service.update(created.id, {
        ...INVOICE_DB,
        include: ['list_invoices', 'get_invoice'],
      });
      expect(row).toMatchObject({ version: 1, versionId: created.versionId });
      expect(await versionsOf(created.id)).toHaveLength(1);
    });

    describe('renaming', () => {
      it('is allowed while no configuration has used the server', async () => {
        const created = await service.create(INVOICE_DB);
        const row = await service.update(created.id, { ...INVOICE_DB, name: 'invoices' });
        expect(row).toMatchObject({ id: created.id, name: 'invoices', version: 1 });
        const [version] = await versionsOf(created.id);
        expect(version!.definitionHash).toBe(definitionHash({ ...INVOICE_DB, name: 'invoices' }));
      });

      it('refuses a name another server has, with 409', async () => {
        await service.create(VENDOR_API);
        const created = await service.create(INVOICE_DB);
        await expect(
          service.update(created.id, { ...INVOICE_DB, name: 'vendor-api' }),
        ).rejects.toThrow(ConflictException);
      });

      it('is refused with 400 once a version is frozen, and after it', async () => {
        const created = await service.create(INVOICE_DB);
        await useInConfiguration(t.db, 'baseline', [created.versionId]);
        const err = await service
          .update(created.id, { ...INVOICE_DB, name: 'invoices' })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          statusCode: 400,
          message: expect.stringMatching(/define a new server with the new name instead$/),
          issues: [{ path: 'name', message: expect.any(String) }],
        });
        // Version 2 is unused, but configurations know the server by its name.
        await service.update(created.id, { ...INVOICE_DB, timeoutS: 99 });
        await expect(
          service.update(created.id, { ...INVOICE_DB, name: 'invoices' }),
        ).rejects.toThrow(BadRequestException);
      });
    });

    it('answers 404 for a server that does not exist', async () => {
      await expect(service.update('mcp_missing', INVOICE_DB)).rejects.toThrow(NotFoundException);
    });
  });

  describe('list', () => {
    it('lists each server at its latest version, by name', async () => {
      const vendor = await service.create(VENDOR_API);
      const invoice = await service.create(INVOICE_DB);
      await useInConfiguration(t.db, 'baseline', [invoice.versionId]);
      await service.update(invoice.id, { ...INVOICE_DB, timeoutS: 99 });
      const rows = await service.list();
      expect(rows.map((r: McpServerRow) => [r.name, r.version, r.frozen])).toEqual([
        ['invoice-db', 2, false],
        ['vendor-api', 1, false],
      ]);
      expect(rows[1]!.id).toBe(vendor.id);
      for (const row of rows) McpServerRowSchema.parse(row);
    });

    it('counts a configuration as a user only while its latest version references the server', async () => {
      const invoice = await service.create(INVOICE_DB);
      const vendor = await service.create(VENDOR_API);
      await useInConfiguration(t.db, 'with-both', [invoice.versionId, vendor.versionId]);
      // Version 1 used invoice-db; its latest, version 2, no longer does.
      await useInConfiguration(t.db, 'dropped', [invoice.versionId], [vendor.versionId]);
      const byName = Object.fromEntries((await service.list()).map((r) => [r.name, r.usedBy]));
      const ids = Object.fromEntries(
        (await t.db.select().from(configurations)).map((c) => [c.name, c.id]),
      );
      expect(byName['invoice-db']).toEqual([
        { configurationId: ids['with-both'], name: 'with-both' },
      ]);
      expect(byName['vendor-api']).toEqual([
        { configurationId: ids.dropped, name: 'dropped' },
        { configurationId: ids['with-both'], name: 'with-both' },
      ]);
    });
  });
});
