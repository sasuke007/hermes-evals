/**
 * Section states the fixtures do not reach on their own, from a board run's detail with one
 * field changed: the final response with invalid JSON or several blocks, a text artifact's
 * preview and a file not stored, each kind of score evidence, and the header actions' disabled
 * reasons (a judge key with no judge model, an unavailable counterpart, five attempts, an
 * API-key provider with no key).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import * as runsApi from '@/api/runs';
import type { RunDetail, ScoreEvidenceView } from '@/api/types/runs';
import { SAMPLE_RUN_ID } from '@/fixtures/experiments';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { useProvidersStore } from '@/stores/providers';
import ArtifactsSection from '../ArtifactsSection.vue';
import FinalResponseSection from '../FinalResponseSection.vue';
import RunActions from '../RunActions.vue';
import ScoreEvidence from '../ScoreEvidence.vue';
import { detailOf, runOf, spaced, squash } from './inspectorEnv';

let wrapper: VueWrapper | null = null;
beforeEach(() => {
  useScenario(null);
  setActivePinia(createPinia());
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
});

const sample = (): RunDetail => detailOf(SAMPLE_RUN_ID);

function withFinal(
  text: string,
  patch: Partial<NonNullable<RunDetail['finalResponse']>>,
): RunDetail {
  const d = sample();
  d.finalResponse = { ...d.finalResponse!, text, ...patch };
  return d;
}

describe('FinalResponseSection', () => {
  it('marks where invalid JSON stopped parsing', () => {
    const text = 'Found two pairs.\n```json\n{"duplicates": [["A","B"],]}\n```';
    const fenceStart = text.indexOf('```json');
    const position = text.indexOf(']}');
    const d = withFinal(text, {
      extraction: 'invalid',
      parsed: null,
      extracted: { start: fenceStart + 8, end: text.lastIndexOf('\n```') },
      fence: { start: fenceStart, end: text.length },
      parseError: { message: 'Expecting value', position },
    });
    wrapper = mount(FinalResponseSection, { props: { detail: d, sectionId: 'ri-final' } });
    expect(squash(wrapper.get('[data-testid="extraction-banner"]').text())).toBe(
      'Invalid JSON in the extracted block · line 3, column 27 · score status ungradable',
    );
    expect(wrapper.get('[data-testid="json-error"]').text()).toBe(']');
    expect(spaced(wrapper.get('[data-testid="parsed-answer"]'))).toContain(
      `Parse error at line 3, column 27 (char ${position}) Expecting value`,
    );
  });

  it('dims the blocks the scorer did not use', () => {
    const text =
      'First pass:\n```json\n{"duplicates": []}\n```\nThen:\n```json\n{"duplicates": [["A", "B"]]}\n```';
    const last = text.lastIndexOf('```json');
    const d = withFinal(text, {
      fence: { start: last, end: text.length },
      extracted: { start: last + 8, end: text.length - 4 },
      parsed: { duplicates: [['A', 'B']] },
    });
    wrapper = mount(FinalResponseSection, { props: { detail: d, sectionId: 'ri-final' } });
    expect(squash(wrapper.get('[data-testid="extraction-banner"]').text())).toBe(
      '2 blocks found · the last one is used',
    );
    expect(wrapper.findAll('[data-testid="json-ignored"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="parsed-answer"]').text()).toContain('block 2 of 2');
  });
});

describe('ArtifactsSection', () => {
  function withArtifacts(items: RunDetail['artifacts']['items']): RunDetail {
    const d = sample();
    d.artifacts = { items, note: null, agentWroteNothing: false };
    return d;
  }
  const agentFile = {
    id: 'art_txt',
    root: 'workspace' as const,
    path: 'workspace/duplicates.txt',
    origin: 'agent' as const,
    sizeBytes: 114,
    sha256: 'c3d58e21'.padEnd(60, '0') + '9a40',
    skippedReason: null,
    preview: null,
  };

  it('previews a text file the agent wrote, as written', async () => {
    const text = 'INV-1042 INV-1107  Brightline Freight\nINV-0988 INV-1131  Kestrel Office Supply';
    const spy = vi.spyOn(runsApi, 'getArtifactText').mockResolvedValue({ text, truncated: false });
    wrapper = mount(ArtifactsSection, {
      props: { detail: withArtifacts([agentFile]), sectionId: 'ri-artifacts' },
    });
    await flushPromises();
    expect(spy).toHaveBeenCalledWith(SAMPLE_RUN_ID, 'art_txt');
    const preview = wrapper.get('[data-testid="artifact-preview"]');
    expect(spaced(preview)).toContain('Preview · duplicates.txt · plain text 2 lines · 114 B');
    expect(preview.get('pre').text()).toBe(text);
    expect(preview.text()).toContain(
      'Shown exactly as written, in monospace, with no formatting applied.',
    );
    expect(wrapper.get('[data-testid="artifact-row"]').text()).toContain('sha256:c3d58e21…9a40');
  });

  it('says why a file was not stored and offers no download', () => {
    wrapper = mount(ArtifactsSection, {
      props: {
        detail: withArtifacts([{ ...agentFile, sha256: null, skippedReason: 'too_large' }]),
        sectionId: 'ri-artifacts',
      },
    });
    const row = wrapper.get('[data-testid="artifact-row"]');
    expect(row.text()).toContain('not stored: the file is too large');
    expect(row.find('a').exists()).toBe(false);
    expect(row.find('button').exists()).toBe(false);
  });

  it('a run that never launched (setup failure) says nothing was collected, not that the task has no fixtures', () => {
    const d = withArtifacts([]);
    d.status = 'execution_error';
    d.launchRecord = null;
    d.artifacts.note = 'partial · collected after the run stopped';
    wrapper = mount(ArtifactsSection, { props: { detail: d, sectionId: 'ri-artifacts' } });
    expect(wrapper.text()).toContain(
      'Nothing was collected: the run stopped before its workspace was set up.',
    );
    expect(wrapper.text()).not.toContain('this task has no fixture files');
    expect(wrapper.text()).not.toContain('partial · collected after the run stopped');
  });

  it('shows a failed preview with Retry', async () => {
    vi.spyOn(runsApi, 'getArtifactText').mockRejectedValue(
      new Error('GET /api/runs/x/artifacts/art_txt/content → 404 · artifact art_txt not found'),
    );
    wrapper = mount(ArtifactsSection, {
      props: { detail: withArtifacts([agentFile]), sectionId: 'ri-artifacts' },
    });
    await flushPromises();
    const preview = wrapper.get('[data-testid="artifact-preview"]');
    expect(preview.text()).toContain('Could not load the preview');
    expect(preview.text()).toContain('404 · artifact art_txt not found');
  });
});

describe('ScoreEvidence', () => {
  const empty: ScoreEvidenceView = {
    eventSeqs: [],
    artifactIds: [],
    judge: null,
    trajectory: null,
    text: null,
    jsonMatch: null,
  };

  it('lists json_match mismatches key by key', () => {
    wrapper = mount(ScoreEvidence, {
      props: {
        evidence: {
          ...empty,
          jsonMatch: {
            unit: 'keys',
            matched: 4,
            total: 5,
            mismatches: ['overdue_by_vendor.Granite Office'],
          },
        },
      },
    });
    expect(spaced(wrapper)).toContain(
      '✗ overdue_by_vendor.Granite Office does not match the reference ✓ the other 4 keys match',
    );
    expect(wrapper.text()).toContain('The score is the share of keys that match.');
  });

  it("shows text_match's phrases found or not", () => {
    wrapper = mount(ScoreEvidence, {
      props: {
        evidence: {
          ...empty,
          text: {
            items: [
              { kind: 'phrase', label: '1.5%', found: true },
              { kind: 'pattern', label: '30 days', found: false },
            ],
            truncated: true,
          },
        },
      },
    });
    expect(spaced(wrapper)).toContain('✓ phrase 1.5% found ✗ pattern 30 days not found');
    expect(wrapper.text()).toContain('The answer is longer than 64 KB');
  });

  it('links the calls trajectory_match counted to the timeline', async () => {
    wrapper = mount(ScoreEvidence, {
      props: {
        evidence: {
          ...empty,
          eventSeqs: [4, 9, 12],
          trajectory: { tool: 'invoice-db.list_invoices', calls: 3, matchedSeqs: [4, 9] },
        } as ScoreEvidenceView,
      },
    });
    expect(spaced(wrapper)).toContain(
      'invoice-db.list_invoices called 3 times · matching calls #4 #9',
    );
    const buttons = wrapper.findAll('button');
    expect(buttons.map((b) => b.text())).toEqual(['#4', '#9', '#12']);
    await buttons[1]!.trigger('click');
    await buttons[2]!.trigger('click');
    expect(wrapper.emitted('seek')).toEqual([[9], [12]]);
  });
});

describe('RunActions', () => {
  async function mountActions(detail: RunDetail, scenario: string | null = null) {
    useScenario(scenario);
    const pinia = createPinia();
    setActivePinia(pinia);
    await useProvidersStore().load();
    const router = createRouter({ history: createMemoryHistory(), routes });
    wrapper = mount(RunActions, { props: { detail }, global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  }

  it("disables Re-score with the API's sentence when a judge key has no model", async () => {
    const d = detailOf(runOf('skillVsNoSkill', 'credit_notes', 'with-skill', 4));
    const reason =
      'Re-score needs a judge model for the method judge: set JUDGE_MODEL (and JUDGE_PROVIDER, nous when unset) in .env, then docker compose up -d api worker.';
    d.needs = { ...d.needs, judgeKeysWithoutModel: ['method'], noJudgeModelReason: reason };
    const w = await mountActions(d);
    const rescore = w.get('[data-testid="rescore"]');
    expect(rescore.attributes('disabled')).toBeDefined();
    expect(rescore.attributes('aria-description')).toBe(reason);
    expect(squash(w.get('[data-testid="blocked-reason"]').text())).toBe(reason);
  });

  it('keeps the A/B jump in place, disabled, with its reason as tooltip and description', async () => {
    const d = sample();
    d.counterpart = {
      runId: 'run_twin',
      configuration: 'with-skill',
      status: 'running',
      unavailableReason: 'Counterpart run is not scored yet (running)',
    };
    const w = await mountActions(d);
    const jump = w.get('[data-testid="ab-jump"]');
    expect(jump.attributes('aria-disabled')).toBe('true');
    expect(jump.attributes('aria-description')).toBe('Counterpart run is not scored yet (running)');
    expect(w.get('[role="tooltip"]').text()).toBe('Counterpart run is not scored yet (running)');
    await jump.trigger('click');
    expect(w.emitted('jump')).toBeUndefined();
  });

  it('stops Retry after five attempts', async () => {
    const d = detailOf(runOf('skillVsNoSkill', 'disputed', 'baseline', 4));
    d.attemptCount = 5;
    const w = await mountActions(d);
    expect(w.get('[data-testid="retry"]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-testid="blocked-reason"]').text()).toBe(
      'This run has had 5 attempts, the most a run can have.',
    );
  });

  it('points an API-key provider with no key at the System page', async () => {
    const d = detailOf(runOf('skillVsNoSkill', 'disputed', 'baseline', 4));
    d.needs = { ...d.needs, provider: 'openrouter' };
    const w = await mountActions(d, 'openrouter-missing');
    const reason = w.get('[data-testid="blocked-reason"]');
    expect(squash(reason.text())).toBe('Retry needs OpenRouter. How to add it');
    expect(reason.get('a').attributes('href')).toBe('/system');
    expect(w.get('[data-testid="retry"]').attributes('disabled')).toBeDefined();
  });
});
