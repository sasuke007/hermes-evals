import { beforeEach, describe, expect, it } from 'vitest';
import { EXPERIMENT_IDS } from '@/fixtures/experiments';
import { listRuns } from '@/api/runs';
import { setScenario } from '@/api/__tests__/scenario';
import type { RunRow } from '@/api/types/runs';
import { bulkRules, type HintPart } from '../bulkRules';
import type { ProviderState } from '../modelAccess';

const SVN = EXPERIMENT_IDS.skillVsNoSkill;
const READY: ProviderState = { id: 'nous', name: 'Nous Portal', ready: true, connectable: true };
const DOWN: ProviderState = { ...READY, ready: false };
const ready = () => READY;
const down = () => DOWN;
const text = (parts: HintPart[]) => parts.map((p) => (p.code ? `\`${p.text}\`` : p.text)).join('');

let rows: RunRow[] = [];
const row = (task: string, config: string, rep: number): RunRow =>
  rows.find((r) => r.taskKey === task && r.configuration.name === config && r.repetition === rep)!;

beforeEach(async () => {
  setScenario(null);
  rows = (await listRuns(SVN)).rows;
});

describe('bulk bar rules (Runs board)', () => {
  it('retries only execution errors and names the next attempt', () => {
    const rules = bulkRules([row('disputed', 'baseline', 4)], ready);
    expect(rules.retryDisabled).toBe(false);
    expect(rules.retryTitle).toBe('Re-executes these runs in fresh trial containers');
    expect(text(rules.hint)).toBe('Creates attempt 3 for each run.');
    // No scored run is selected: nothing to re-score.
    expect(rules.rescoreDisabled).toBe(true);
    expect(rules.blocked).toBe(false);
  });

  it('takes at most 500 runs per request, whatever they are', () => {
    const scored = rows.filter((r) => r.status === 'scored');
    const many = Array.from({ length: 501 }, (_, i) => scored[i % scored.length]!);
    const rules = bulkRules(many, ready);
    expect(rules.rescoreDisabled).toBe(true);
    expect(rules.retryDisabled).toBe(true);
    expect(rules.rescoreTitle).toBe('Select at most 500 runs');
    expect(rules.retryTitle).toBe('Select at most 500 runs');
    expect(text(rules.hint)).toBe('Select at most 500 runs; 501 are selected.');
    expect(rules.blocked).toBe(true);
    expect(rules.connect).toBe(false);
    // 500 is allowed.
    expect(bulkRules(many.slice(0, 500), ready).rescoreDisabled).toBe(false);
  });

  it('says why Retry execution is unavailable for a mixed selection', () => {
    const rules = bulkRules(
      [
        row('disputed', 'baseline', 4),
        row('total_due', 'baseline', 1),
        row('total_due', 'baseline', 2),
      ],
      ready,
    );
    expect(rules.retryDisabled).toBe(true);
    expect(rules.retryTitle).toBe(
      'Retry execution only applies to runs with status execution_error',
    );
    expect(text(rules.hint)).toBe(
      '2 selected run(s) are not `execution_error`; retry is unavailable.',
    );
    expect(rules.rescoreDisabled).toBe(false);
    expect(rules.rescoreTitle).toBe('Re-runs scorers on the stored output');
  });

  it('blocks Re-score while the judge provider is not connected, with Connect', () => {
    const rules = bulkRules(
      [row('credit_notes', 'baseline', 1), row('total_due', 'baseline', 1)],
      down,
    );
    expect(rules.rescoreDisabled).toBe(true);
    expect(rules.rescoreTitle).toBe('Re-score needs Nous Portal for the method judge.');
    expect(text(rules.hint)).toBe('Re-score needs Nous Portal for the `method` judge.');
    expect(rules.blocked).toBe(true);
    expect(rules.connect).toBe(true);
  });

  it('blocks Retry while the run provider is not connected', () => {
    const rules = bulkRules([row('disputed', 'baseline', 4)], down);
    expect(rules.retryDisabled).toBe(true);
    expect(text(rules.hint)).toBe('Retry needs Nous Portal.');
    expect(rules.connect).toBe(true);
  });

  it('disables Re-score with the API sentence when a judge key has no model', () => {
    const reason =
      'Re-score needs a judge model for the method judge: set JUDGE_MODEL (and JUDGE_PROVIDER, nous when unset) in .env, then docker compose up -d api worker.';
    const credit = row('credit_notes', 'baseline', 1);
    const noModel: RunRow = {
      ...credit,
      needs: { ...credit.needs, judgeKeysWithoutModel: ['method'], noJudgeModelReason: reason },
    };
    const rules = bulkRules([noModel], ready);
    expect(rules.rescoreDisabled).toBe(true);
    expect(rules.rescoreTitle).toBe(reason);
    expect(text(rules.hint)).toBe(reason);
    expect(rules.connect).toBe(false);
  });

  it('refuses a run that already has 5 attempts', () => {
    const exec = row('disputed', 'baseline', 4);
    const rules = bulkRules([{ ...exec, attempts: 5 }], ready);
    expect(rules.retryDisabled).toBe(true);
    expect(text(rules.hint)).toBe(
      '1 selected run(s) already have 5 attempts; retry is unavailable.',
    );
  });
});
