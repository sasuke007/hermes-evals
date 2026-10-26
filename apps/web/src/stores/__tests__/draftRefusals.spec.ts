/**
 * Uploads refused for their size (Phase 5b question 11): the ones the API keeps are read from
 * readiness, merged with those refused at the drop, and only the first limit + 1 bytes of a
 * refused file go to the API.
 */
import { describe, expect, it } from 'vitest';
import { AUTHORING_LIMITS } from '@hermes-evals/shared';
import type { ReadinessIssue } from '@/api/types/authoring';
import {
  OVER_LIMIT_REASON,
  keptRefusals,
  mergeRefusals,
  refusalHead,
  type RejectedFile,
} from '../draftRefusals';

const refused = (field: string, section: ReadinessIssue['target']['section']): ReadinessIssue => ({
  rule: 'file_limits',
  severity: 'problem',
  target: { section, field },
  message: `\`${field.slice(field.lastIndexOf('/') + 1)}\` is over 25 MB.`,
});

describe('draft refusals', () => {
  it('reads the refusals the API keeps from its file_limits problems', () => {
    const issues: ReadinessIssue[] = [
      refused('fixtures/ledger-2025.parquet', 'workspace'),
      refused('home/memories/USER.md', 'home'),
      { ...refused('fixtures/big.csv', 'workspace'), severity: 'warning' },
      { ...refused('fixtures/other.csv', 'workspace'), message: 'Too many files.' },
    ];
    expect(keptRefusals(issues)).toEqual([
      {
        name: 'ledger-2025.parquet',
        kind: 'fixture',
        sizeBytes: null,
        reason: OVER_LIMIT_REASON,
        path: 'fixtures/ledger-2025.parquet',
      },
      {
        name: 'USER.md',
        kind: 'home_seed',
        sizeBytes: null,
        reason: OVER_LIMIT_REASON,
        path: 'home/memories/USER.md',
      },
    ]);
  });

  it('lists those refused here first, then the kept ones not already shown or dismissed', () => {
    const here: RejectedFile = {
      name: 'a.parquet',
      kind: 'fixture',
      sizeBytes: 30e6,
      reason: OVER_LIMIT_REASON,
      path: 'fixtures/a.parquet',
    };
    const kept = keptRefusals([
      refused('fixtures/a.parquet', 'workspace'),
      refused('fixtures/b.parquet', 'workspace'),
      refused('fixtures/c.parquet', 'workspace'),
    ]);
    expect(mergeRefusals([here], kept, ['fixtures/c.parquet']).map((r) => r.path)).toEqual([
      'fixtures/a.parquet',
      'fixtures/b.parquet',
    ]);
  });

  it('sends only the first limit + 1 bytes of a refused file', () => {
    const file = new File([new Uint8Array(AUTHORING_LIMITS.suiteMaxFileBytes + 10)], 'big.bin', {
      type: 'application/octet-stream',
    });
    const head = refusalHead(file);
    expect(head.size).toBe(AUTHORING_LIMITS.suiteMaxFileBytes + 1);
    expect(head.name).toBe('big.bin');
    expect(head.type).toBe('application/octet-stream');
  });
});
