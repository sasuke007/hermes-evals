import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { TaskExperimentUsage } from '@/api/types/suites';
import { routes } from '@/router';
import NewerSuiteNotice from '../NewerSuiteNotice.vue';
import TaskUsagePanel from '../TaskUsagePanel.vue';
import VerificationSentence from '../VerificationSentence.vue';
import VerifierScriptPanel from '../VerifierScriptPanel.vue';
import ZoneLabel from '../ZoneLabel.vue';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

const router = () => createRouter({ history: createMemoryHistory(), routes });
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('NewerSuiteNotice', () => {
  it('names the newer version, what changed in it, and links Duplicate on it', () => {
    wrapper = mount(NewerSuiteNotice, {
      props: {
        experimentId: 'exp_1',
        suite: {
          name: 'invoices-v1',
          newerVersion: {
            suiteId: 's2',
            versionNumber: 5,
            changedTasks: ['total_due'],
            removedTasks: [],
            invalidTasks: [],
          },
        },
      },
      global: { plugins: [router()] },
    });
    const notice = wrapper.get('[data-testid="newer-suite-version"]');
    expect(notice.attributes('role')).toBe('status');
    expect(flat(notice.find('span').text())).toBe(
      'A newer version of invoices-v1 exists (v5): 1 task changed (total_due).',
    );
    const link = notice.get('a');
    expect(link.text()).toBe('Duplicate on v5');
    expect(link.attributes('href')).toBe('/experiments/new?from=exp_1');
  });

  it('names removed and invalid tasks too, and draws nothing without a newer version', async () => {
    wrapper = mount(NewerSuiteNotice, {
      props: {
        experimentId: 'exp_1',
        suite: {
          name: 'invoices-v1',
          newerVersion: {
            suiteId: 's2',
            versionNumber: 2,
            changedTasks: ['late_fees'],
            removedTasks: ['vat_split'],
            invalidTasks: ['late_fees'],
          },
        },
      },
      global: { plugins: [router()] },
    });
    expect(flat(wrapper.get('[data-testid="newer-suite-version"] > span').text())).toBe(
      'A newer version of invoices-v1 exists (v2): 1 task changed (late_fees), 1 task removed (vat_split), 1 task now invalid (late_fees).',
    );
    await wrapper.setProps({ suite: { name: 'invoices-v1', newerVersion: null } });
    expect(wrapper.find('[data-testid="newer-suite-version"]').exists()).toBe(false);
  });
});

describe('VerifierScriptPanel', () => {
  const source = Array.from({ length: 38 }, (_, i) =>
    i === 30 ? '        rate = policy["late_fee_rate"]' : `line ${i + 1}`,
  ).join('\n');
  const verifier = {
    path: 'verify/check_late_fees.py',
    sha256: `2e7d90b1${'0'.repeat(52)}c3a8`,
    source,
  };
  const failure = {
    key: 'check',
    type: 'verifier_script' as const,
    title:
      'verifier_script check_late_fees.py printed no result line on the reference answer · score status error',
    status: 'error' as const,
    ranAt: '2026-10-23T15:41:07',
    durationMs: 300,
    previousRun: null,
    transcript:
      'Traceback (most recent call last):\n  File "verify/check_late_fees.py", line 31, in <module>\n    rate = policy["late_fee_rate"]\nKeyError: \'late_fee_rate\'',
    explanation: '',
  };

  it('marks the line the traceback names and opens the source around it', async () => {
    wrapper = mount(VerifierScriptPanel, { props: { verifier, failure } });
    const marked = wrapper.get('[data-marked="true"]');
    expect(marked.attributes('data-line')).toBe('31');
    const lines = wrapper.findAll('[data-line]').map((l) => l.attributes('data-line'));
    expect([lines[0], lines[lines.length - 1]]).toEqual(['21', '38']);
    expect(flat(wrapper.text())).toContain(
      'Lines 21–38 of 38 · the marked line raised the error in the last self-check',
    );
    expect(flat(wrapper.get('[role="note"]').text())).toBe(
      "31KeyError: 'late_fee_rate' on the reference answer, self-check 23 Oct 15:41.",
    );
    expect(wrapper.text()).toContain('sha256:2e7d90b1…c3a8');
    await wrapper.get('button.linkbtn').trigger('click');
    expect(wrapper.findAll('[data-line]')).toHaveLength(38);
  });

  it('keeps the caption whole when a short script is shown in full', () => {
    // late_fees v2: 15 lines, the error on line 11, so every line shows.
    const short = { ...verifier, source: source.split('\n').slice(0, 15).join('\n') };
    const at11 = { ...failure, transcript: failure.transcript.replace('line 31', 'line 11') };
    wrapper = mount(VerifierScriptPanel, { props: { verifier: short, failure: at11 } });
    expect(wrapper.get('[data-marked="true"]').attributes('data-line')).toBe('11');
    expect(wrapper.findAll('[data-line]')).toHaveLength(15);
    expect(wrapper.find('button.linkbtn').exists()).toBe(false);
    const caption = flat(wrapper.get('span.text-12.text-text-3 > span').text());
    expect(caption).toBe(
      'Verifier scripts are edited on disk. Lines 1–15 of 15 · the marked line raised the error in the last self-check',
    );
    expect(caption).not.toContain('disk. ·');
  });

  it('says there is none for built-in checks, with the contract', () => {
    wrapper = mount(VerifierScriptPanel, { props: { verifier: null } });
    expect(wrapper.text()).toContain("None. This task's checks use built-in types only.");
    expect(wrapper.text()).toContain('Contract for every verifier script');
  });
});

describe('TaskUsagePanel', () => {
  const usage: TaskExperimentUsage[] = [
    {
      experimentId: 'e1',
      experimentName: 'MCP vs baseline',
      status: 'running',
      rows: [
        { configuration: 'baseline', role: 'baseline', passRate: 0.25, scored: 4, total: 5 },
        { configuration: 'with-mcp', role: 'candidate', passRate: null, scored: 0, total: 5 },
      ],
    },
  ];

  it('shows a running experiment with its chip and scored / total', () => {
    wrapper = mount(TaskUsagePanel, {
      props: { experiments: usage, version: 2, versioned: true },
      global: { plugins: [router()] },
    });
    const rows = wrapper.findAll('tbody tr');
    expect(rows[0]!.get('[data-kind="experiment"]').text()).toBe('running');
    expect(flat(rows[0]!.findAll('td')[2]!.text())).toBe('0.25 4 / 5');
    expect(flat(rows[1]!.findAll('td')[2]!.text())).toBe('– 0 / 5');
    expect(rows[1]!.findAll('td')[0]!.text()).toBe('');
    expect(wrapper.text()).toContain(
      'Only experiments on task v2 are listed. Results on other versions are not comparable.',
    );
  });

  it('says when no experiment has run the task yet', () => {
    wrapper = mount(TaskUsagePanel, {
      props: { experiments: [], version: 1, versioned: false },
      global: { plugins: [router()] },
    });
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.text()).toContain('No experiment has run task v1 yet.');
  });
});

describe('VerificationSentence and ZoneLabel', () => {
  it('sets the type in mono and the values in code', () => {
    wrapper = mount(VerificationSentence, {
      props: {
        entry: {
          type: 'text_match',
          params: { path: 'rule', contains: ['1.5%', '30 days'] },
          sentence: 'text_match on rule, contains "1.5%", "30 days"',
        },
      },
    });
    expect(wrapper.get('.font-mono').text()).toBe('text_match');
    expect(wrapper.findAll('[data-testid="sentence-value"]').map((c) => c.text())).toEqual([
      'rule',
      '"1.5%"',
      '"30 days"',
    ]);
  });

  it('labels what the agent sees and what it never sees', () => {
    wrapper = mount(ZoneLabel, { props: { zone: 'hidden' } });
    expect(wrapper.text()).toBe('Hidden from the agent');
    expect(wrapper.attributes('data-zone')).toBe('hidden');
  });
});
