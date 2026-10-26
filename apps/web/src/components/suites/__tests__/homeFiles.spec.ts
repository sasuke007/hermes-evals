/**
 * Task detail's home files (Phase 6 P1 and P2): the home seeds after the fixtures, the
 * expected_home files after the reference, each with its kind, and a file_check on the home
 * tagged `root: home` in the check list. The page under `memory-files`, the panel with props.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { TaskHomeFile, VerificationEntryView } from '@/api/types/suites';
import { SUITE_V1_ID } from '@/fixtures/suites';
import { mountAt, unmountPage } from '@/views/suites/__tests__/mountPage';
import HomeFilesPanel from '../HomeFilesPanel.vue';
import VerificationPanel from '../VerificationPanel.vue';

afterEach(() => unmountPage());

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const cells = (row: { findAll: (s: string) => { text: () => string }[] }) =>
  row.findAll('td').map((td) => flat(td.text()));

const seed: TaskHomeFile = {
  kind: 'home_seed',
  path: 'home/memories/USER.md',
  homePath: 'memories/USER.md',
  sizeBytes: 42,
  sha256: 'a08c'.padEnd(60, '0') + '1f2e',
  text: 'Reports amounts in EUR.\n§\nPrefers short answers.\n',
};
const expected: TaskHomeFile = {
  kind: 'expected_home',
  path: 'expected_home/memories/USER.md',
  homePath: 'memories/USER.md',
  sizeBytes: 90,
  sha256: '7c3f'.padEnd(60, '0') + '9b0a',
  text: null,
};

describe('HomeFilesPanel', () => {
  it('lists the seeds with their kind, where they land in the home, size and hash', async () => {
    const w = mount(HomeFilesPanel, { props: { kind: 'home_seed', files: [seed, expected] } });
    expect(w.get('h2').text()).toBe('Home seeds');
    expect(w.get('[data-zone]').attributes('data-zone')).toBe('visible');
    expect(w.text()).toContain("Copied into the agent's memories/ before every run");
    const rows = w.findAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(cells(rows[0]!).slice(0, 5)).toEqual([
      'home/memories/USER.md',
      'home_seed',
      '/opt/data/memories/USER.md',
      '42 B',
      'sha256:a08c0000…1f2e',
    ]);
    // A seed with text opens it as written, entries and § included.
    const text = w.get('[data-testid="home-file-text"]');
    expect(text.get('pre').text()).toBe(seed.text!.trimEnd());
    await rows[0]!.get('button').trigger('click');
    expect(w.find('[data-testid="home-file-text"]').exists()).toBe(false);
    expect(rows[0]!.get('button').text()).toBe('Show text');
  });

  it('lists expected_home files as hidden from the agent, with no text button without text', () => {
    const w = mount(HomeFilesPanel, { props: { kind: 'expected_home', files: [seed, expected] } });
    expect(w.get('h2').text()).toBe('Expected home');
    expect(w.get('[data-zone]').attributes('data-zone')).toBe('hidden');
    expect(w.text()).toContain('never copied into a run');
    const row = w.get('tbody tr');
    expect(cells(row).slice(0, 3)).toEqual([
      'expected_home/memories/USER.md',
      'expected_home',
      'memories/USER.md',
    ]);
    expect(row.find('button').exists()).toBe(false);
  });

  it('names a file of a nested expected_home folder by its path in the home', () => {
    // self_check.expected_home may be any folder of the task's own; the API strips it whole.
    const nested: TaskHomeFile = {
      ...expected,
      path: 'known_good/home/memories/USER.md',
      homePath: 'memories/USER.md',
    };
    const w = mount(HomeFilesPanel, { props: { kind: 'expected_home', files: [seed, nested] } });
    expect(cells(w.get('tbody tr')).slice(0, 3)).toEqual([
      'known_good/home/memories/USER.md',
      'expected_home',
      'memories/USER.md',
    ]);
  });

  it('draws nothing when the task has no file of its kind', () => {
    const w = mount(HomeFilesPanel, { props: { kind: 'expected_home', files: [seed] } });
    expect(w.find('section').exists()).toBe(false);
  });
});

describe('VerificationPanel', () => {
  const check = (root: string): VerificationEntryView => ({
    key: 'saved',
    type: 'file_check',
    primary: false,
    params: { root, path: root === 'home' ? 'memories/USER.md' : 'summary.csv', must_exist: true },
    yaml: '- key: saved',
    sentence: 'file_check: memories/USER.md in the home exists',
  });

  it('tags a file_check on the home, and not one on the workspace', () => {
    const w = mount(VerificationPanel, {
      props: { verification: [check('home'), { ...check('workspace'), key: 'summary' }] },
    });
    const tags = (key: string) =>
      w
        .get(`[data-check="${key}"]`)
        .findAll('.tag')
        .map((t) => t.text());
    expect(tags('saved')).toEqual(['file_check', 'root: home']);
    expect(tags('summary')).toEqual(['file_check']);
  });
});

describe('TaskDetailPage with home files (memory-files)', () => {
  it('shows per_vendor’s seeds, its expected_home file and its home check', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V1_ID}/tasks/per_vendor`, 'memory-files');
    const seeds = w.get('[data-home-kind="home_seed"]');
    expect(seeds.findAll('tbody tr').map((r) => cells(r)[0])).toEqual([
      'home/memories/MEMORY.md',
      'home/memories/USER.md',
    ]);
    expect(flat(seeds.get('pre').text())).toContain('§');
    const expectedHome = w.get('[data-home-kind="expected_home"]');
    expect(cells(expectedHome.get('tbody tr')).slice(0, 2)).toEqual([
      'expected_home/memories/USER.md',
      'expected_home',
    ]);
    // Seeds come after the fixtures, expected_home after the reference answer.
    const order = [...w.element.querySelectorAll('h2')].map((h) => h.textContent?.trim());
    expect(order.indexOf('Home seeds')).toBe(order.indexOf('Fixtures') + 1);
    expect(order.indexOf('Expected home')).toBeGreaterThan(order.indexOf('Verification'));
    expect(w.get('[data-check="saved_preference"] [data-testid="check-root"]').text()).toBe(
      'root: home',
    );
    expect(w.text()).toContain('passes on the expected home; fails on the home seeds alone');
  });

  it('shows no home panels for a task without home files', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V1_ID}/tasks/per_vendor`);
    expect(w.find('[data-home-kind]').exists()).toBe(false);
    expect(w.find('[data-testid="check-root"]').exists()).toBe(false);
  });
});
