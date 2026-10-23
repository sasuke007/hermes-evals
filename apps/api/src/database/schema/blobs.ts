/**
 * The content-addressed blob store, as the database sees it. Every file the
 * platform keeps (task fixtures, verifier scripts, rubrics, expected
 * workspaces, documents, collected artifacts) is stored once at
 * DATA_DIR/blobs/<sha256>. A row here means the file exists: it is written
 * (temp file, fsync, rename) before the row is inserted, in the same
 * transaction as the row that references it. Foreign keys from task_files,
 * documents and artifacts then guarantee a referenced blob is never removed,
 * so re-scoring never depends on a trial workspace surviving.
 */
import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text } from 'drizzle-orm/pg-core';
import { isSha256, tstz } from './_columns.js';

export const blobs = pgTable(
  'blobs',
  {
    sha256: text('sha256').primaryKey(),
    size: bigint('size', { mode: 'number' }).notNull(),
    storedAt: tstz('stored_at').notNull().defaultNow(),
  },
  (t) => [
    check('blobs_sha256_ck', isSha256(t.sha256)),
    check('blobs_size_ck', sql`${t.size} >= 0`),
  ],
);
