import { describe, expect, it } from 'vitest';
import type { DraftConflict } from '@/api/types/authoring';
import type { TextDiffLine } from '@/api/types/suites';
import {
  combineBlockedReason,
  combineLabel,
  conflictCause,
  conflictGuidance,
  conflictHeadline,
  rebaseRequest,
} from '../conflict';
import { sideSummary, sideText } from '../conflictSides';

const conflict = (overlap: string[]): DraftConflict => ({
  cause: 'version_moved',
  baseVersion: 6,
  current: {
    suiteId: 's7',
    name: 'invoices-v1',
    versionNumber: 7,
    versionLabel: '0.3',
    contentHash: 'a'.repeat(64),
    loadedAt: '2026-10-23T16:40:12',
  },
  diskChanges: {
    added: [],
    removed: [],
    changed: overlap.length ? ['late_fees', 'total_due'] : ['late_fees'],
    nowInvalid: [],
    nowValid: ['late_fees'],
  },
  draftKeys: ['overdue_count', 'total_due'],
  overlap,
});

describe('draft conflict wording (SA.12)', () => {
  it('says the folder changed on disk, what the reload did and the draft base', () => {
    expect(conflictHeadline('./suites/invoices-v1')).toBe(
      '`./suites/invoices-v1` changed on disk after this draft began.',
    );
    expect(conflictCause(conflict([]))).toBe(
      'A reload at 16:40 created v7 (`late_fees` now valid). Your draft is based on v6.',
    );
  });

  it('can combine at once when the two sides touch different tasks', () => {
    expect(conflictGuidance(conflict([]), {})).toBe(
      "Your changes (`overdue_count`, `total_due`) don't touch `late_fees`. They can be combined.",
    );
    expect(combineBlockedReason(conflict([]), {})).toBeNull();
    expect(combineLabel(conflict([]))).toBe('Combine onto v7');
    expect(rebaseRequest(conflict([]), {})).toEqual({ onto: 7, choices: [] });
  });

  it('waits for a choice on each task both sides changed', () => {
    const c = conflict(['total_due']);
    expect(conflictGuidance(c, {})).toBe(
      'Both changed `total_due`. Choose which version to keep below, then combine.',
    );
    expect(combineBlockedReason(c, {})).toBe('Choose a version for total_due first.');
    const chosen = { total_due: 'mine' as const };
    expect(conflictGuidance(c, chosen)).toBe(
      'Both changed `total_due`. You chose a version for it, so the draft can be combined.',
    );
    expect(combineBlockedReason(c, chosen)).toBeNull();
    expect(rebaseRequest(c, { total_due: 'disk' })).toEqual({
      onto: 7,
      choices: [{ key: 'total_due', keep: 'disk' }],
    });
  });
});

const line = (kind: TextDiffLine['kind'], text: string): TextDiffLine => ({
  kind,
  text,
  oldLine: kind === 'added' ? null : 1,
  newLine: kind === 'removed' ? null : 1,
});

describe('the sides of an overlapping task', () => {
  it('reads each side as it now is, its new lines marked, and sums up what it changed', () => {
    const prompt = [
      line('same', 'An invoice is settled only when its status is paid.'),
      line('added', 'Credit notes have negative amounts and reduce the total.'),
      line('same', 'What is the total amount still due?'),
    ];
    expect(sideText(prompt)).toEqual([
      { text: 'An invoice is settled only when its status is paid.', changed: false },
      { text: 'Credit notes have negative amounts and reduce the total.', changed: true },
      { text: 'What is the total amount still due?', changed: false },
    ]);
    const yaml = [
      line('removed', '  params: { abs: 0.01 }'),
      line('added', '  params: { abs: 0.005 }'),
    ];
    expect(sideSummary({ prompt, taskYaml: [], reference: [], files: [] }, 6)).toBe(
      'prompt +1 line · task.yaml as in v6',
    );
    expect(sideSummary({ prompt: [], taskYaml: yaml, reference: [], files: [] }, 6)).toBe(
      'prompt as in v6 · task.yaml +1 line −1 line',
    );
  });

  it('keeps only the stretches around a change in a long text', () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      line(i === 15 ? 'added' : 'same', `line ${i}`),
    );
    const kept = sideText(lines);
    expect(kept.map((l) => l.text)).toEqual([
      'line 13',
      'line 14',
      'line 15',
      'line 16',
      'line 17',
      '…',
    ]);
  });
});
