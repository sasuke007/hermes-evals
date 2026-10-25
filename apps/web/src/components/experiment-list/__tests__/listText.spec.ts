import { describe, expect, it } from 'vitest';
import type { ExperimentListRow } from '@/api/types/experiments';
import { experimentListRowFixture, experimentSeeds } from '@/fixtures/experiments';
import {
  matchesSearch,
  noIntervalText,
  noVerdictText,
  progressLabel,
  progressTone,
  taskCountOf,
  verdictTitle,
} from '../listText';

const rows = experimentSeeds(() => false).map(experimentListRowFixture);
const named = (name: string): ExperimentListRow => {
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(name);
  return row;
};

describe('listText', () => {
  it('derives the task count from runs, configurations and repetitions', () => {
    expect(taskCountOf(named('Skill + MCP, invoices-v1'))).toBe(12);
    expect(taskCountOf(named('Skill vs no skill, quick check'))).toBe(12);
  });

  it('words each reason for no interval the way the board words one repetition', () => {
    const row = { ...named('MCP smoke test, invoices-v1'), totalRuns: 2 * 2 * 3 };
    expect(noIntervalText('single_repetition', row)).toBe('No interval (1 rep)');
    expect(noIntervalText('too_few_tasks', row)).toBe('No interval (2 tasks)');
    expect(noIntervalText('too_few_tasks', { ...row, totalRuns: 6 })).toBe('No interval (1 task)');
    expect(noIntervalText('nothing_scored', row)).toBe('No interval (nothing scored)');
    expect(noIntervalText('not_enough_runs', row)).toBe('No interval (too few runs)');
    expect(noIntervalText(null, row)).toBe('No interval');
  });

  it('says Provisional while live, unless the experiment can never have an interval', () => {
    const running = named('MCP vs baseline, invoices-v1');
    expect(noVerdictText(running)).toBe('Provisional');
    expect(noVerdictText(named('Skill vs no skill, quick check'))).toBe('No interval (1 rep)');
    expect(noVerdictText({ ...running, totalRuns: 2 * 2 * 5 })).toBe('No interval (2 tasks)');
    expect(noVerdictText(named('MCP vs baseline, first try'))).toBe('–');
  });

  it('titles a chip with Δ and its interval, true minus signs included', () => {
    const [verdict] = named('MCP smoke test, invoices-v1').verdicts;
    expect(verdictTitle(verdict!)).toBe('Δ +0.056, 95% CI [−0.111, +0.250]');
    expect(verdictTitle({ ...verdict!, lo: null, hi: null })).toBe('Δ +0.056, no interval');
  });

  it('tones and labels the progress bar by status', () => {
    expect(progressTone(named('MCP vs baseline, invoices-v1'))).toBe('run');
    expect(progressTone(named('MCP vs baseline, first try'))).toBe('err');
    expect(progressTone(named('Skill vs no skill, quick check'))).toBe('que');
    expect(progressTone(named('Skill vs no skill, invoices-v1'))).toBe('muted');
    expect(progressLabel(named('MCP vs baseline, invoices-v1'))).toBe('87 of 120 runs scored');
    expect(progressLabel(named('MCP smoke test, invoices-v1'))).toBe('72 of 72 runs done');
  });

  it('searches names, the suite and the configurations, every word', () => {
    const row = named('Skill + MCP, invoices-v1');
    expect(matchesSearch(row, '')).toBe(true);
    expect(matchesSearch(row, 'with-mcp')).toBe(true);
    expect(matchesSearch(row, 'INVOICES skill')).toBe(true);
    expect(matchesSearch(row, 'smoke')).toBe(false);
  });
});
