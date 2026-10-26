/**
 * ExperimentSummaryPanel's maths and disabled reasons (plan 12.4), in each state Components 2
 * draws: incomplete, valid, over ceiling, unknown price, blocked (Nous Portal, an API key, the
 * worker), launching and launch failed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { ExperimentEstimateView } from '@/api/types/experiments';
import { routes } from '@/router';
import ExperimentSummaryPanel from '../ExperimentSummaryPanel.vue';
import type { LaunchBlocker } from '../launchReadiness';

const PRICES = [
  { model: 'openai/gpt-6.1-sol', inputPer1M: 0.6, outputPer1M: 2.4, checkedAt: '2026-10-20' },
];
const ESTIMATE: ExperimentEstimateView = {
  runs: 120,
  waves: 40,
  perRunSeconds: 55,
  durationS: 2180,
  costUsd: 1.69,
  perConfiguration: [
    { versionId: 'a', name: 'baseline', runs: 60, costUsd: 0.71 },
    { versionId: 'b', name: 'with-skill', runs: 60, costUsd: 0.98 },
  ],
  basis: 'history',
  pastRuns: 192,
};
const BASE = {
  taskCount: 12,
  configCount: 2,
  repetitions: 5,
  concurrency: 3,
  estimate: ESTIMATE,
  suiteName: 'invoices-v1',
  perRunTokens: 19_800,
  priceTable: PRICES,
  models: ['openai/gpt-6.1-sol', 'openai/gpt-6.1-sol'],
  invalidReason: null,
};

function mountPanel(props: Record<string, unknown> = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  return mount(ExperimentSummaryPanel, {
    props: { ...BASE, ...props },
    global: { plugins: [createPinia(), router] },
    attachTo: document.body,
  });
}

const launchButton = (w: ReturnType<typeof mountPanel>) => w.get('[data-testid="launch"]');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ExperimentSummaryPanel', () => {
  it('shows the multiplication, the estimate and its basis, and launches', async () => {
    const w = mountPanel();
    expect(w.get('[data-testid="summary-factors"]').text()).toMatch(
      /Tasks\s*12\s*× Configurations\s*2\s*× Repetitions\s*5\s*= Runs\s*120/,
    );
    expect(w.get('[data-testid="summary-duration"]').text()).toBe('≈ 36 min');
    expect(w.text()).toContain('40 waves at concurrency 3 × 55 s median per run');
    expect(w.get('[data-testid="summary-cost"]').text()).toBe('≈ $1.69');
    expect(w.text()).toContain('120 runs at the per-configuration median cost');
    expect(w.findAll('[data-testid="summary-cost-row"]').map((r) => r.text())).toEqual([
      'baseline≈ $0.71',
      'with-skill≈ $0.98',
    ]);
    expect(w.text()).toContain(
      'Estimates use the medians of 192 past runs on invoices-v1 per configuration, and the price table for openai/gpt-6.1-sol: $0.60 in / $2.40 out per 1M tokens.',
    );
    expect(launchButton(w).text()).toBe('Launch 120 runs');
    expect(launchButton(w).attributes('disabled')).toBeUndefined();
    expect(w.get('[data-testid="launch-reason"]').text()).toBe(
      'Starts immediately. You can pause or cancel from the Overview.',
    );
    await launchButton(w).trigger('click');
    expect(w.emitted('launch')).toHaveLength(1);
  });

  it('incomplete: Runs —, no estimate, Launch disabled with the first unmet requirement', () => {
    const w = mountPanel({
      configCount: 1,
      estimate: null,
      invalidReason: 'Pick at least two configurations.',
    });
    expect(w.get('[data-testid="summary-runs"]').text()).toBe('—');
    expect(w.find('[data-testid="summary-duration"]').exists()).toBe(false);
    expect(launchButton(w).text()).toBe('Launch');
    expect(launchButton(w).attributes('disabled')).toBeDefined();
    const reason = w.get('[data-testid="launch-reason"]');
    expect(reason.text()).toBe('Pick at least two configurations.');
    expect(launchButton(w).attributes('aria-describedby')).toBe(reason.attributes('id'));
  });

  it('factors that are missing read —', () => {
    const w = mountPanel({ taskCount: null, repetitions: null, estimate: null });
    expect(w.get('[data-testid="summary-factors"]').text()).toMatch(
      /Tasks\s*—\s*× Configurations\s*2\s*× Repetitions\s*—/,
    );
  });

  it('a long estimate reads in hours and minutes', () => {
    const w = mountPanel({ estimate: { ...ESTIMATE, durationS: 3900 } });
    expect(w.get('[data-testid="summary-duration"]').text()).toBe('≈ 1h 05m');
  });

  it('without history: budget ÷ 4 and the tokens per run, at the one model price', () => {
    const w = mountPanel({
      perRunTokens: 15_000,
      estimate: { ...ESTIMATE, basis: 'budget', perRunSeconds: 75, durationS: 3000, pastRuns: 0 },
    });
    expect(w.text()).toContain('40 waves at concurrency 3 × 75 s per run');
    expect(w.text()).toContain('120 runs × 15,000 tokens at $0.60 in / $2.40 out per 1M');
    expect(w.text()).toContain(
      'No past runs on invoices-v1 yet, so the per-run estimate assumes the time budget ÷ 4 and 15,000 tokens. After the first experiment it uses the measured medians.',
    );
  });

  it('when only some configurations have run on the suite, the note names the ones that have not', () => {
    const budget = { ...ESTIMATE, basis: 'budget' as const, perRunSeconds: 13, pastRuns: 0 };
    const one = mountPanel({
      perRunTokens: 15_000,
      estimate: budget,
      withoutHistory: ['with-mcp'],
    });
    expect(one.text()).toContain(
      'with-mcp has no past runs on invoices-v1 yet, so its per-run estimate assumes the time budget ÷ 4 and 15,000 tokens; the other configurations use their measured medians.',
    );
    expect(one.text()).not.toContain('No past runs on invoices-v1 yet');

    const two = mountPanel({
      configCount: 3,
      perRunTokens: 15_000,
      estimate: budget,
      withoutHistory: ['with-skill', 'with-mcp'],
    });
    expect(two.text()).toContain(
      'with-skill and with-mcp have no past runs on invoices-v1 yet, so their per-run estimates assume the time budget ÷ 4 and 15,000 tokens; the other configurations use their measured medians.',
    );

    const none = mountPanel({
      perRunTokens: 15_000,
      estimate: budget,
      withoutHistory: ['baseline', 'with-skill'],
    });
    expect(none.text()).toContain('No past runs on invoices-v1 yet, so the per-run estimate');
  });

  it('over the spend ceiling: an amber line, Launch stays enabled', () => {
    const w = mountPanel({ spendCeilingUsd: 1.5 });
    expect(w.get('[data-testid="over-ceiling"]').text()).toBe(
      'Estimated $1.69 is over the ceiling of $1.50. The experiment will pause when spend reaches $1.50. Raise the ceiling in section 5 to avoid the pause.',
    );
    expect(w.text()).toContain('Spend ceiling$1.50');
    expect(launchButton(w).attributes('disabled')).toBeUndefined();
    expect(mountPanel({ spendCeilingUsd: 2 }).find('[data-testid="over-ceiling"]').exists()).toBe(
      false,
    );
  });

  it('unknown price: cost —, the model named, Launch stays enabled', () => {
    const w = mountPanel({
      models: ['openai/gpt-6.1-sol', 'anthropic/claude-5.1-sonnet'],
      estimate: {
        ...ESTIMATE,
        costUsd: null,
        perConfiguration: ESTIMATE.perConfiguration.map((p, i) => ({
          ...p,
          costUsd: i === 1 ? null : p.costUsd,
        })),
      },
    });
    expect(w.get('[data-testid="summary-cost"]').text()).toBe('—');
    expect(w.get('[data-testid="unknown-price"]').text()).toBe(
      'No price for anthropic/claude-5.1-sonnet in the price table. Add it in config/prices.yaml to see estimates.',
    );
    expect(launchButton(w).attributes('disabled')).toBeUndefined();
  });

  it('blocked by Nous Portal: the block with Connect, Launch disabled through BlockedReason', async () => {
    const blocker: LaunchBlocker = {
      reason: "Can't launch yet: Nous Portal is not connected.",
      fix: 'connect',
      provider: 'nous',
      providerName: 'Nous Portal',
      configurations: ['baseline', 'with-skill'],
      detail: null,
      envVar: null,
      command: null,
      missing: [],
    };
    const w = mountPanel({ blockers: [blocker] });
    const block = w.get('[data-testid="launch-blocker"]');
    expect(block.text()).toContain("Can't launch yet: Nous Portal is not connected.");
    expect(launchButton(w).text()).toBe('Launch 120 runs');
    expect(launchButton(w).attributes('disabled')).toBeDefined();
    expect(launchButton(w).attributes('title')).toBe(
      "Can't launch yet: Nous Portal is not connected.",
    );
    expect(w.get('[data-testid="blocked-reason"]').text()).toBe(
      "Can't launch yet: Nous Portal is not connected. Connect",
    );
    await block.get('button').trigger('click');
    await w.get('[data-testid="blocked-reason"] button').trigger('click');
    expect(w.emitted('connect')).toHaveLength(2);
  });

  it('blocked by a missing API key: the .env step with Copy and System, no Connect', () => {
    const blocker: LaunchBlocker = {
      reason: "Can't launch yet: OpenRouter has no API key.",
      fix: 'add-key',
      provider: 'openrouter',
      providerName: 'OpenRouter',
      configurations: ['or-baseline'],
      detail: null,
      envVar: 'OPENROUTER_API_KEY',
      command: 'docker compose up -d egress worker',
      missing: [],
    };
    const w = mountPanel({ blockers: [blocker] });
    const block = w.get('[data-testid="launch-blocker"]');
    expect(block.text()).toContain(
      'or-baseline uses openrouter. The platform never accepts keys in the UI.',
    );
    expect(block.text()).toContain(
      'Add OPENROUTER_API_KEY=… to .env, then run docker compose up -d egress worker',
    );
    expect(block.find('button[aria-label="Copy the command"]').exists()).toBe(true);
    expect(block.get('a').attributes('href')).toBe('/system');
    expect(block.text()).not.toContain('Connect');
    const reason = w.get('[data-testid="blocked-reason"]');
    expect(reason.text()).toBe("Can't launch yet: OpenRouter has no API key. How to add it");
    expect(reason.get('a').attributes('href')).toBe('/system');
  });

  it("an incomplete form's reason comes before a blocker's", () => {
    const blocker: LaunchBlocker = {
      reason: "Can't launch yet: no worker is connected.",
      fix: 'command',
      provider: null,
      providerName: null,
      configurations: [],
      detail: 'Runs start only on a live worker. Start one with:',
      envVar: null,
      command: 'docker compose up -d worker',
      missing: [],
    };
    const w = mountPanel({ blockers: [blocker], invalidReason: 'Give the experiment a name.' });
    expect(w.get('[data-testid="launch-reason"]').text()).toBe('Give the experiment a name.');
    expect(w.find('[data-testid="blocked-reason"]').exists()).toBe(false);
    expect(w.get('[data-testid="launch-blocker"]').text()).toContain('docker compose up -d worker');
  });

  it('launching: spinner, busy, the form locked', () => {
    const w = mountPanel({ busy: true });
    expect(launchButton(w).text()).toBe('Launching…');
    expect(launchButton(w).attributes('aria-busy')).toBe('true');
    expect(launchButton(w).attributes('disabled')).toBeDefined();
    expect(w.text()).toContain(
      'Freezing the snapshot and queueing 120 runs. The form is locked until the server answers.',
    );
  });

  it('launch failed: the alert with the verbatim line, and Connect when it fixes it', async () => {
    const w = mountPanel({
      failure: {
        kind: 'provider',
        title: 'Launch refused: Nous Portal is not connected.',
        message: 'POST /api/experiments → 409 · Nous Portal is not connected',
        hint: 'The login ended after this page loaded. Nothing was created and your form is unchanged.',
        action: 'connect',
      },
    });
    const alert = w.get('[role="alert"]');
    expect(alert.text()).toContain('Launch refused: Nous Portal is not connected.');
    expect(alert.get('code').text()).toBe(
      'POST /api/experiments → 409 · Nous Portal is not connected',
    );
    await alert.get('button').trigger('click');
    expect(w.emitted('connect')).toHaveLength(1);
    expect(launchButton(w).attributes('disabled')).toBeUndefined();
  });

  it('says so when the estimate could not be made', () => {
    const w = mountPanel({
      estimate: null,
      estimateError: 'GET /api/experiments/estimate → 404 · suite x not found',
    });
    expect(w.get('[data-testid="estimate-error"]').text()).toBe(
      'Could not estimate: GET /api/experiments/estimate → 404 · suite x not found',
    );
    expect(w.get('[data-testid="summary-duration"]').text()).toBe('—');
  });
});
