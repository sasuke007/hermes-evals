/**
 * System › Judge and samples (Phase 8 G2, G3) in each designed state, from fixtures: the judge
 * (a real one, the mock model, the mock's model name on another endpoint, no JUDGE_MODEL), the
 * samples seed (done, running and polled,
 * one sample refused, stopped, off) and a failed read. Every answer is the shared contract's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { SystemSetupSchema, type JudgeView } from '@hermes-evals/shared';
import * as systemApi from '@/api/system';
import { SEED_FAILED_ERROR, systemSetupFixture } from '@/fixtures/setup';
import { routes } from '@/router';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import SystemPage from '@/views/system/SystemPage.vue';
import { judgeDetail, judgeSetting, judgeStatus, seedDetail } from '../setupText';

let wrapper: VueWrapper | null = null;

async function mountPage(scenario: string | null) {
  useScenario(scenario);
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/system');
  await router.isReady();
  wrapper = mount(SystemPage, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  useProvidersStore().dispose();
  useSystemStore().dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
const section = () => wrapper!.get('section[data-section="setup"]');
const row = (part: 'judge' | 'seed') =>
  section()
    .get(`tr[data-setup="${part}"]`)
    .findAll('td')
    .map((td) => flat(td.text()));

describe('System › Judge and samples', () => {
  it('sits under Model access, with the judge and the seed of this start', async () => {
    const w = await mountPage(null);
    expect(w.findAll('h2').map((h) => h.text())).toEqual([
      'Model access',
      'Judge and samples',
      'Secrets',
      'Sandbox',
      'Workers',
    ]);
    expect(section().text()).toContain('read when the api starts');
    expect(row('judge')).toEqual([
      'LLM judge',
      'nous · openai/gpt-6.1-sol',
      'real model',
      'llm_judge checks that name no model of their own are graded by openai/gpt-6.1-sol through nous.',
    ]);
    expect(row('seed')).toEqual([
      'Samples',
      'SEED_SAMPLES on',
      'done',
      '3 created · 2 skipped · 0 failed, at 09:00:03.',
    ]);
  });

  it('lists the samples on demand, with what happened to each', async () => {
    await mountPage(null);
    expect(section().find('#setup-samples').exists()).toBe(false);
    const toggle = section().get('[data-testid="seed-items-toggle"]');
    expect(toggle.text()).toBe('Show the 5 samples');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    const rows = section().findAll('#setup-samples tbody tr');
    expect(rows.map((r) => r.findAll('td').map((td) => flat(td.text())))).toEqual([
      ['Skill', 'invoice-method', 'created', 'version 1.0.0'],
      ['Skill', 'house-style', 'skipped', 'exists with the same content'],
      ['Document', 'knowledge-v1/house-style.md', 'created', ''],
      ['MCP server', 'invoice-db', 'created', ''],
      [
        'Configuration',
        'invoices-v1-baseline-mock',
        'skipped',
        'a configuration with this name exists',
      ],
    ]);
    expect(toggle.text()).toBe('Hide the samples');
    await toggle.trigger('click');
    expect(section().find('#setup-samples').exists()).toBe(false);
  });

  it('judge-mock: marks the mock judge and says how to set a real one', async () => {
    await mountPage('judge-mock');
    const [part, setting, status, detail] = row('judge');
    expect([part, setting, status]).toEqual(['LLM judge', 'custom · mock/scripted', 'mock model']);
    expect(
      section().get('tr[data-setup="judge"] [data-kind="judge"]').attributes('data-tone'),
    ).toBe('ung');
    expect(detail).toBe(
      "The scripted mock model grades llm_judge checks: right for the samples on the mock model, meaningless on a real model's answers. For a real judge, set JUDGE_PROVIDER and JUDGE_MODEL in .env. Then run docker compose up -d api worker.",
    );
  });

  it("judge-mock-name: flags the mock's model name on an endpoint that is not the mock", async () => {
    await mountPage('judge-mock-name');
    const [part, setting, status, detail] = row('judge');
    expect([part, setting, status]).toEqual(['LLM judge', 'custom · mock/scripted', 'check model']);
    expect(
      section().get('tr[data-setup="judge"] [data-kind="judge"]').attributes('data-tone'),
    ).toBe('ung');
    expect(detail).toBe(
      "JUDGE_MODEL is mock/scripted, the mock model's name, but JUDGE_BASE_URL is not the mock model: a real endpoint fails every llm_judge check that names no model. Set JUDGE_MODEL in .env. Then run docker compose up -d api worker.",
    );
  });

  it('seed-running: reads the setup again every 2 s until the seed ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi.spyOn(systemApi, 'getSystemSetup');
    await mountPage('seed-running');
    expect(row('seed')).toEqual([
      'Samples',
      'SEED_SAMPLES on',
      'running',
      'Adding the samples since 09:00:00: 2 samples so far.',
    ]);
    const before = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(read.mock.calls.length).toBe(before + 1);
    // The seed ends: polling stops.
    read.mockResolvedValue(SystemSetupSchema.parse(systemSetupFixture(() => false)));
    await vi.advanceTimersByTimeAsync(2_100);
    await flushPromises();
    expect(row('seed')[2]).toBe('done');
    const settled = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(read.mock.calls.length).toBe(settled);
  });

  it('seed-item-failed: opens the list with the refused sample in red', async () => {
    await mountPage('seed-item-failed');
    expect(row('seed')[3]).toBe('3 created · 2 skipped · 1 failed, at 09:00:03.');
    const failed = section().get('#setup-samples tr[data-seed-item="mcp-v1-with-mcp-mock"]');
    expect(failed.findAll('td').map((td) => flat(td.text()))).toEqual([
      'Configuration',
      'mcp-v1-with-mcp-mock',
      'failed',
      'MCP server vendor-directory does not exist',
    ]);
    expect(failed.findAll('td')[3]!.classes()).toContain('text-fail-text');
  });

  it('seed-failed: says why the seed stopped, and that the API runs on', async () => {
    await mountPage('seed-failed');
    expect(row('seed').slice(0, 3)).toEqual(['Samples', 'SEED_SAMPLES on', 'failed']);
    expect(section().get('[data-testid="seed-error"]').text()).toBe(SEED_FAILED_ERROR);
    expect(section().text()).toContain('Stopped at 09:00:03, after 0 samples. The API runs on');
    expect(section().find('[data-testid="seed-items-toggle"]').exists()).toBe(false);
  });

  it('seed-off: says this start added no samples', async () => {
    await mountPage('seed-off');
    expect(row('seed')).toEqual([
      'Samples',
      'SEED_SAMPLES off',
      'off',
      'SEED_SAMPLES is off, so this start added no samples.',
    ]);
  });

  it('a failed read replaces the table with the error and its Retry', async () => {
    await mountPage('error');
    const banner = section().get('[role="alert"]');
    expect(banner.text()).toContain('Could not load the judge and the samples');
    expect(banner.text()).toContain('GET /api/system/setup → 502');
    expect(section().find('table').exists()).toBe(false);
  });
});

describe('setupText', () => {
  const judge = (over: Partial<JudgeView>): JudgeView => ({
    provider: 'nous',
    model: 'openai/gpt-6.1-sol',
    mock: false,
    mockModelName: false,
    ...over,
  });

  it('names the judge, and says when JUDGE_MODEL is unset', () => {
    expect(judgeSetting(judge({ model: null }))).toBe('nous · no model');
    expect(judgeDetail(judge({ model: null }))).toBe(
      'JUDGE_MODEL is not set: only llm_judge checks that name their own model are graded, and a launch with one that names none is refused.',
    );
  });

  it('gives the mock first, then the mock model name elsewhere, then a real judge', () => {
    expect(judgeStatus(judge({ mock: true }))).toBe('mock');
    expect(judgeStatus(judge({ mockModelName: true }))).toBe('mock_name');
    expect(judgeStatus(judge({}))).toBe('real');
  });

  it('counts a finished seed', () => {
    const { seed } = SystemSetupSchema.parse(systemSetupFixture((n) => n === 'seed-item-failed'));
    expect(seedDetail(seed)).toBe('3 created · 2 skipped · 1 failed, at 09:00:03.');
  });
});
