/**
 * ReadinessPanel in the states of SA.8 (plan 12.4): ready, problems and warnings with their
 * Fix links, self-check not run with its button, running, an erred script's transcript, the
 * worker offline, and a refused upload counted as a file-limits problem.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { READINESS_RULES, summariseReadiness } from '@hermes-evals/shared';
import type { ReadinessRuleResult, TaskReadiness } from '@/api/types/authoring';
import ReadinessPanel from '../ReadinessPanel.vue';

function readiness(
  set: Partial<Record<string, Partial<ReadinessRuleResult>>> = {},
  needsWorker = false,
): TaskReadiness {
  const rules = READINESS_RULES.map((rule) => ({
    rule,
    status: 'passed' as const,
    message: '',
    target: null,
    ...set[rule],
  }));
  const { summary, counts } = summariseReadiness(rules);
  return {
    summary,
    counts,
    rules,
    issues: [],
    mentionedFiles: [],
    referenceValues: [],
    needsWorker,
    checkedAt: '2026-10-23T16:31:00',
  };
}

const panel = (r: TaskReadiness, props: Record<string, unknown> = {}) =>
  mount(ReadinessPanel, {
    props: { readiness: r, taskLabel: 'overdue_count · draft · saved 16:31', ...props },
  });

describe('ReadinessPanel', () => {
  it('lists the 13 rules with the board labels and reads Ready to save', () => {
    const w = panel(
      readiness({
        self_check: { message: 'Reference passes `answer` · checked live as you type' },
      }),
    );
    expect(w.findAll('li')).toHaveLength(13);
    expect(w.get('[data-rule="key_summary"]').text()).toContain('Key and summary are set');
    expect(w.get('[data-rule="negative_control"]').text()).toContain("Doing nothing doesn't pass");
    expect(w.get('[data-testid="readiness-head"]').text()).toContain('Ready to save');
    expect(w.get('[data-rule="self_check"] [data-testid="rule-message"] code').text()).toBe(
      'answer',
    );
    expect(w.find('[data-testid="run-self-check"]').exists()).toBe(false);
    expect(w.text()).toContain("Problems don't block saving.");
  });

  it('counts problems and warnings, and Fix goes to the field', async () => {
    const target = { section: 'answer' as const, field: 'answerPath' };
    const w = panel(
      readiness({
        reference_paths: {
          status: 'problem',
          message: 'No value at `overdue` (check `answer`).',
          target,
        },
        answer_block: {
          status: 'warning',
          message: "The prompt doesn't ask for a fenced json block.",
          target: { section: 'prompt', field: 'prompt' },
        },
        mentioned_files: {
          status: 'warning',
          message: '`ledger.csv` is mentioned but not in workspace files.',
          target: { section: 'workspace', field: null },
        },
      }),
    );
    expect(w.get('[data-testid="readiness-head"]').text()).toMatch(/1 problem\s*·\s*2 warnings/);
    expect(w.get('[data-rule="reference_paths"]').attributes('data-status')).toBe('problem');
    expect(w.findAll('button').filter((b) => b.text() === 'Fix')).toHaveLength(3);
    await w.get('[data-rule="reference_paths"] button').trigger('click');
    expect(w.emitted('fix')?.[0]).toEqual([target]);
  });

  it('asks for Run self-check when file checks or scripts have not run', async () => {
    const r = readiness(
      {
        self_check: {
          status: 'pending',
          message: 'File checks and verifier scripts run in the worker. Takes seconds.',
        },
        negative_control: { status: 'pending', message: 'Shown after the self-check.' },
      },
      true,
    );
    const w = panel(r);
    expect(w.get('[data-testid="readiness-head"]').text()).toContain(
      'Self-check not run since your last change',
    );
    await w.get('[data-testid="run-self-check"]').trigger('click');
    expect(w.emitted('runSelfCheck')).toHaveLength(1);
  });

  it('shows the run in progress', () => {
    const r = readiness({ self_check: { status: 'pending', message: '' } }, true);
    const w = panel(r, { selfCheckState: 'running', workerChecks: 2 });
    expect(w.get('[data-testid="readiness-head"]').text()).toContain('Running self-check…');
    expect(w.text()).toContain('Running 2 checks…');
  });

  it("shows an erred script's transcript", () => {
    const r = readiness(
      {
        self_check: {
          status: 'problem',
          message: '`totals`: the verifier script exited with status 1, so the check is error.',
          target: { section: 'checks', field: null },
        },
      },
      true,
    );
    const w = panel(r, { transcript: "$ python3 verify/check_summary.py\nKeyError: 'totals'" });
    expect(w.get('[data-testid="self-check-transcript"]').text()).toContain("KeyError: 'totals'");
  });

  it('says the worker is offline and how to start it, keeping the draft', () => {
    const r = readiness({ self_check: { status: 'pending', message: '' } }, true);
    const w = panel(r, { selfCheckState: 'offline' });
    expect(w.get('[data-rule="self_check"]').text()).toContain(
      "The worker isn't running, so file checks and scripts can't be self-checked. Your draft is kept.",
    );
    expect(w.get('[data-rule="self_check"] code').text()).toBe('docker compose up -d worker');
  });

  it('counts a refused upload as a file-limits problem', () => {
    const w = panel(readiness(), {
      overrides: {
        file_limits: {
          rule: 'file_limits',
          status: 'problem',
          message: '`ledger-2025.parquet` is over 25 MB.',
          target: { section: 'workspace', field: null },
        },
      },
    });
    expect(w.get('[data-testid="readiness-head"]').text()).toContain('1 problem');
    expect(w.get('[data-rule="file_limits"]').text()).toContain(
      'ledger-2025.parquet is over 25 MB.',
    );
  });
});
