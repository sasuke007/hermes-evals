/**
 * The artifacts view with the home's memory files (Phase 6 P2): each item
 * carries its root and is named from the trial root, and the home's files
 * follow the workspace's.
 */
import { ArtifactsViewSchema } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { artifactsView } from './artifacts.js';
import type { ArtifactRecord } from './rows.js';

const record = (
  over: Partial<ArtifactRecord> & Pick<ArtifactRecord, 'id' | 'path'>,
): ArtifactRecord => ({
  attemptId: 'attempt',
  root: 'workspace',
  origin: 'agent',
  size: 10,
  sha256: 'a'.repeat(64),
  skippedReason: null,
  ...over,
});

describe('artifactsView', () => {
  it('names each file from the trial root and lists the home after the workspace', () => {
    const view = ArtifactsViewSchema.parse(
      artifactsView(
        { status: 'executed', errorCategory: null },
        [
          record({ id: 'm', root: 'home', path: 'memories/USER.md', origin: 'home_seed_modified' }),
          record({ id: 's', path: 'summary.csv' }),
          record({ id: 'n', root: 'home', path: 'memories/MEMORY.md', origin: 'agent' }),
          // The same relative path may exist under both roots.
          record({ id: 'w', path: 'memories/USER.md', origin: 'agent' }),
          record({ id: 'i', path: 'invoices.csv', origin: 'fixture_unchanged' }),
        ],
        new Map(),
      ),
    );
    expect(view.items.map((a) => [a.id, a.root, a.path, a.origin])).toEqual([
      ['i', 'workspace', 'workspace/invoices.csv', 'fixture_unchanged'],
      ['w', 'workspace', 'workspace/memories/USER.md', 'agent'],
      ['s', 'workspace', 'workspace/summary.csv', 'agent'],
      ['n', 'home', 'home/memories/MEMORY.md', 'agent'],
      ['m', 'home', 'home/memories/USER.md', 'home_seed_modified'],
    ]);
    expect(view.agentWroteNothing).toBe(false);
  });

  it('says the agent wrote nothing when its only writes are memory files', () => {
    const view = artifactsView(
      { status: 'executed', errorCategory: null },
      [
        record({ id: 'i', path: 'invoices.csv', origin: 'fixture_unchanged' }),
        record({ id: 'n', root: 'home', path: 'memories/MEMORY.md', origin: 'agent' }),
      ],
      new Map(),
    );
    expect(view.agentWroteNothing).toBe(true);
  });
});
