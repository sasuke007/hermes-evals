import { describe, expect, it } from 'vitest';
import {
  attemptText,
  cellComment,
  cellLabel,
  cellLook,
  cellMeta,
  CELL_TONES,
  tallyCells,
} from '../cells';
import type { RepetitionCell } from '@/api/types/experiments';

const cell = (over: Partial<RepetitionCell> = {}): RepetitionCell => ({
  runId: 'run_1',
  repetition: 3,
  runStatus: 'scored',
  scoreStatus: 'failed',
  attempt: 1,
  durationS: 52,
  comment: 'expected 2 duplicate pairs, got 0; agent compared invoice numbers only',
  ...over,
});

describe('cell looks', () => {
  it('follows the selected key once scored, the run status before', () => {
    expect(cellLook(cell({ scoreStatus: 'passed' }))).toBe('passed');
    expect(cellLook(cell({ scoreStatus: 'error' }))).toBe('error');
    expect(cellLook(cell({ scoreStatus: 'ungradable' }))).toBe('ungradable');
    expect(cellLook(cell({ runStatus: 'execution_error', scoreStatus: null }))).toBe(
      'execution_error',
    );
    for (const status of ['queued', 'running', 'executed', 'scoring', 'cancelled'] as const) {
      expect(cellLook(cell({ runStatus: status, scoreStatus: null }))).toBe(status);
    }
    // error and execution_error share the violet look and tone (the legend's one swatch).
    expect(CELL_TONES.error).toBe('err');
    expect(CELL_TONES.execution_error).toBe('err');
  });

  it('writes the tooltip lines as the board does', () => {
    expect(cellMeta(cell())).toBe('scored · 52 s · attempt 1');
    expect(
      cellMeta(
        cell({ runStatus: 'execution_error', durationS: 310, attempt: 2, scoreStatus: null }),
      ),
    ).toBe('execution_error · 5m 10s · attempt 2 of 2');
    expect(cellMeta(cell({ runStatus: 'running', durationS: null }))).toBe('running · attempt 1');
    expect(cellMeta(cell({ runStatus: 'scoring' }))).toBe('executed · scoring');
    expect(cellMeta(cell({ runStatus: 'queued', durationS: null }))).toBe('queued');
    expect(attemptText(1)).toBe('attempt 1');
    expect(cellComment(cell({ runStatus: 'queued' }))).toBe('Not scored yet.');
    expect(cellComment(cell({ runStatus: 'cancelled', comment: null }))).toBe(
      'Cancelled: not counted in the pass rates.',
    );
    expect(cellComment(cell())).toBe(
      'expected 2 duplicate pairs, got 0; agent compared invoice numbers only',
    );
    expect(cellLabel(cell(), 'dup_invoices', 'baseline')).toBe(
      'dup_invoices, baseline, repetition 3, failed. Open run.',
    );
  });

  it('counts scored and execution_error runs toward the rate', () => {
    expect(
      tallyCells([
        cell({ scoreStatus: 'passed' }),
        cell({ scoreStatus: 'failed' }),
        cell({ runStatus: 'execution_error', scoreStatus: null }),
        cell({ runStatus: 'queued', scoreStatus: null }),
        cell({ runStatus: 'cancelled', scoreStatus: null }),
      ]),
    ).toEqual({ passed: 1, counted: 3 });
  });
});
