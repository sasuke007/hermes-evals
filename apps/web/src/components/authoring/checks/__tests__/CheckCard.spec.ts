/**
 * CheckCard per type with its rule line (plan 12.4), its result chip and menu, Try it,
 * the expected-workspace run and a script shown read-only; CheckPicker's groups, suggestion,
 * disabled script card and keyboard; and the Checks section's primary rules (SA.7, SA.7a).
 */
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { TaskFormCheck } from '@/api/types/authoring';
import type { TryState } from '@/stores/draftTaskTools';
import CheckCard from '../CheckCard.vue';
import CheckPicker from '../CheckPicker.vue';
import ChecksSection from '../ChecksSection.vue';

const card = (check: TaskFormCheck, props: Record<string, unknown> = {}) =>
  mount(CheckCard, {
    props: { check, answerPath: 'overdue_count', expanded: true, ...props },
    attachTo: document.body,
  });

describe('CheckCard', () => {
  it('shows Number within tolerance with its fields, rule line and Try it', () => {
    const w = card(
      { key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } },
      { referenceValue: 17 },
    );
    expect(w.get('[data-testid="check-key"]').text()).toBe('answer');
    expect(w.text()).toContain('Absolute tolerance');
    expect(w.text()).toContain('Relative tolerance');
    expect(w.find('input[placeholder="inherits overdue_count"]').exists()).toBe(true);
    expect(w.get('[data-testid="rule-line"]').text()).toBe(
      'Passes when |answer − 17| ≤ 0. With neither tolerance: passes only when the numbers are equal. Scores 1 or 0.',
    );
    expect(w.find('[data-testid="try-it"]').exists()).toBe(true);
    w.unmount();
  });

  it.each([
    ['json_match', 'Share of keys that must match', 'Ignore list order'],
    ['exact_match', 'Trim whitespace', 'Case-sensitive'],
    ['text_match', 'Must contain', 'Share that must be found'],
    ['file_check', 'File path in the workspace', 'Required columns'],
    ['trajectory_match', 'Arguments to match', 'Compare the whole trajectory'],
    ['llm_judge', 'Pass threshold', 'Judge model'],
    ['verifier_script', 'Timeout (s)', 'Verifier scripts are edited on disk.'],
  ] as const)('shows the %s settings', (type, a, b) => {
    const scripts = [{ path: 'verify/check_summary.py', sizeBytes: 1200, sha256: 'a'.repeat(64) }];
    const w = card(
      {
        key: 'check',
        type,
        primary: false,
        params: type === 'verifier_script' ? { script: 'check_summary.py' } : {},
      },
      { scripts, scriptSource: 'print(1)\n' },
    );
    expect(w.text()).toContain(a);
    expect(w.text()).toContain(b);
    w.unmount();
  });

  it('says when a check needs a real run', () => {
    const w = card({
      key: 'tool_use',
      type: 'trajectory_match',
      primary: false,
      params: { tool: 'read_file' },
    });
    expect(w.text()).toContain(
      "Checked when runs are scored. A self-check can't test this without a real run.",
    );
    expect(w.get('[data-testid="check-result"]').text()).toBe('checked when runs are scored');
    w.unmount();
  });

  it('turns its chip into a problem and asks to fix the setting', () => {
    const w = card(
      { key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: -1 } },
      { errors: { abs: "Tolerance can't be negative." } },
    );
    expect(w.get('[data-testid="check-result"]').text()).toBe('settings invalid');
    expect(w.text()).toContain("Tolerance can't be negative.");
    expect(w.get('[data-testid="rule-line"]').text()).toBe(
      'Fix the tolerance to see when this check passes.',
    );
    w.unmount();
  });

  it('reads no value at the path when the reference has none', () => {
    const w = card(
      { key: 'answer', type: 'numeric_tolerance', primary: true, params: {} },
      { answerPath: 'overdue', referenceMissing: true, expanded: false },
    );
    expect(w.get('[data-testid="check-result"]').text()).toBe(
      'no value at overdue in the reference',
    );
    w.unmount();
  });

  it('emits whole edits, the primary radio, and Delete after it asks', async () => {
    const w = card(
      { key: 'answer', type: 'numeric_tolerance', primary: false, params: { abs: 0 } },
      { expanded: false },
    );
    await w.get('[role="radio"]').trigger('click');
    expect(w.emitted('makePrimary')).toHaveLength(1);
    await w.get('[aria-label="Delete check answer"]').trigger('click');
    expect(w.get('[role="alertdialog"]').text()).toContain('Delete check answer?');
    await w
      .findAll('[role="alertdialog"] button')
      .find((b) => b.text() === 'Delete')!
      .trigger('click');
    expect(w.emitted('delete')).toHaveLength(1);
    await w.setProps({ expanded: true });
    await w.get('input[inputmode="decimal"]').setValue('0.5');
    const updates = w.emitted('update') ?? [];
    expect(updates[updates.length - 1]?.[0]).toMatchObject({ params: { abs: 0.5 } });
    w.unmount();
  });

  it('offers Change type…, Duplicate check and Delete in the ⋯ menu, and Undo after a change', async () => {
    const w = card(
      { key: 'answer', type: 'exact_match', primary: true, params: {} },
      { changedFrom: { from: 'json_match', dropped: ['share of keys'] } },
    );
    expect(w.text()).toContain('Changed from JSON match. Dropped: share of keys.');
    await w.get('[aria-label="More actions for answer"]').trigger('click');
    expect(w.findAll('[role="menuitem"]').map((m) => m.text())).toEqual([
      'Change type…',
      'Duplicate check',
      'Delete',
    ]);
    await w.findAll('[role="menuitem"]')[0]!.trigger('click');
    expect(w.emitted('changeType')).toHaveLength(1);
    await w.get('button.linkbtn').trigger('click');
    expect(w.emitted('undoChange')).toHaveLength(1);
    w.unmount();
  });

  it('shows Try it against the reference and on a pasted reply', async () => {
    const tryState: TryState = {
      reference: {
        key: 'answer',
        type: 'numeric_tolerance',
        against: 'reference',
        extraction: null,
        path: 'overdue_count',
        value: '17',
        status: 'passed',
        score: 1,
        comment: '|17 − 17| = 0 ≤ 0',
        passAt: null,
        evidence: null,
      },
      referenceError: null,
      reply: 'x',
      replyResult: {
        key: 'answer',
        type: 'numeric_tolerance',
        against: 'reply',
        extraction: { status: 'found', block: '{ "overdue_count": 18 }', error: null },
        path: 'overdue_count',
        value: '18',
        status: 'failed',
        score: 0,
        comment: '|18 − 17| = 1 > 0',
        passAt: null,
        evidence: null,
      },
      replyError: null,
      busy: false,
    };
    const w = card(
      { key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } },
      { tryState },
    );
    expect(w.get('[data-testid="try-reference-chip"]').text()).toContain('passed');
    expect(w.get('[data-testid="check-result"]').text()).toBe('passes on the reference');
    await w.get('[data-testid="try-it"] button[aria-expanded]').trigger('click');
    // A flex row with gaps: the words are separate elements.
    expect(w.text().replace(/\s+/g, '')).toContain(
      'Againstthereference:passed·score1onoverdue_count',
    );
    expect(w.get('[data-testid="try-extracted"]').text()).toBe('{ "overdue_count": 18 }');
    expect(w.get('[data-testid="try-value"]').text()).toBe('18');
    expect(w.get('[data-testid="try-result"]').text()).toContain(
      '|18 − 17| = 1 > 0 · score 0 · failed',
    );
    await w.get('[data-testid="try-reply"]').setValue('new reply');
    expect(w.emitted('reply')?.[0]).toEqual(['new reply']);
    w.unmount();
  });

  it('checks a file against the expected workspace, with the negative control', () => {
    const results = [
      {
        key: 'file',
        type: 'file_check' as const,
        mode: 'workspace' as const,
        expect: 'pass' as const,
        status: 'passed' as const,
        score: 1,
        comment: '`/workspace/summary.csv` exists',
        transcript: null,
      },
      {
        key: 'file',
        type: 'file_check' as const,
        mode: 'workspace' as const,
        expect: 'fail' as const,
        status: 'failed' as const,
        score: 0,
        comment: "`summary.csv` doesn't exist",
        transcript: null,
      },
    ];
    const w = card(
      {
        key: 'file',
        type: 'file_check',
        primary: true,
        params: { path: 'summary.csv', format: 'csv' },
      },
      { selfCheckResults: results, selfCheckSeconds: 0.4 },
    );
    const panel = w.get('[data-testid="expected-run"]');
    expect(panel.text()).toContain(
      'On the expected workspace: /workspace/summary.csv exists · score 1 · 0.4 s',
    );
    expect(panel.text()).toContain('failed, as it should');
    expect(w.get('[data-testid="check-result"]').text()).toBe('passes on the expected workspace');
    w.unmount();
  });

  it('shows a verifier script read-only with its path, size and hash', () => {
    const scripts = [
      {
        path: 'verify/check_summary.py',
        sizeBytes: 1229,
        sha256: '9b14e0d2'.padEnd(60, '0') + 'a3c8',
      },
    ];
    const w = card(
      {
        key: 'totals',
        type: 'verifier_script',
        primary: false,
        params: { script: 'check_summary.py' },
      },
      { scripts, scriptSource: 'import csv\nprint(1)\n' },
    );
    const source = w.get('[data-testid="script-source"]');
    expect(source.text()).toContain('verify/check_summary.py');
    expect(source.text()).toContain('1.2 KB');
    expect(source.text()).toContain('sha256:9b14e0d2…a3c8');
    expect(source.text()).toContain('read-only here');
    expect(source.find('textarea').exists()).toBe(false);
    w.unmount();
  });
});

describe('CheckPicker', () => {
  it('groups the cards, marks the suggestion and disables the script card without scripts', () => {
    const w = mount(CheckPicker, {
      props: {
        suggested: {
          type: 'json_match',
          reason: 'the reference at `overdue_by_vendor` is an object',
        },
      },
      attachTo: document.body,
    });
    expect(w.findAll('[role="group"]').map((g) => g.attributes('aria-label'))).toEqual([
      'Answer checks',
      'Workspace checks',
      'Behaviour',
      'Judge',
      'Script',
    ]);
    expect(w.get('[data-type="json_match"]').text()).toContain('Suggested');
    expect(w.get('[data-type="verifier_script"]').attributes('aria-disabled')).toBe('true');
    expect(w.text()).toContain('No scripts in verify/. Add one on disk, then reload.');
    w.unmount();
  });

  it('moves with the arrow keys, picks with Enter and closes with Esc', async () => {
    const w = mount(CheckPicker, { props: { noReference: true }, attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain('Add the reference answer to get a suggestion.');
    const list = w.get('[role="listbox"]');
    expect(list.attributes('aria-activedescendant')).toBe('ck-opt-numeric_tolerance');
    await list.trigger('keydown', { key: 'ArrowDown' });
    expect(list.attributes('aria-activedescendant')).toBe('ck-opt-json_match');
    await list.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('pick')?.[0]).toEqual(['json_match']);
    await list.trigger('keydown', { key: 'Escape' });
    expect(w.emitted('close')).toBeTruthy();
    w.unmount();
  });

  it('marks and disables the current type in replace mode', () => {
    const w = mount(CheckPicker, {
      props: {
        mode: 'replace',
        checkKey: 'answer',
        currentType: 'json_match',
        scripts: ['check_summary.py'],
      },
    });
    expect(w.get('h2').text()).toBe('Change answer to…');
    expect(w.get('[data-type="json_match"]').attributes('aria-disabled')).toBe('true');
    expect(w.get('[data-type="json_match"]').text()).toContain('This is the current type.');
    expect(w.get('[data-type="verifier_script"]').attributes('aria-disabled')).toBeUndefined();
  });
});

describe('Checks section', () => {
  const base = {
    answerPath: 'overdue_by_vendor',
    reference: { overdue_by_vendor: { a: 1 } },
    referenceValues: [],
    issues: [],
    tries: {},
    selfCheck: null,
    expectedFolder: null,
    scripts: [],
    sources: {},
    rubrics: {},
  };

  it('starts empty, and the first check added is primary and says so', async () => {
    const w = mount(ChecksSection, { props: { ...base, checks: [] }, attachTo: document.body });
    expect(w.get('[data-testid="no-checks"]').text()).toContain(
      'Add at least one check. The first one becomes primary.',
    );
    await w.get('[data-testid="add-check"]').trigger('click');
    expect(w.get('[data-testid="check-picker"]').text()).toContain('Suggested');
    await w.get('[data-type="json_match"]').trigger('click');
    const [checks] = w.emitted('update')![0] as [TaskFormCheck[]];
    expect(checks).toEqual([{ key: 'answer', type: 'json_match', primary: true, params: {} }]);
    await w.setProps({ checks });
    expect(w.get('[data-testid="primary-note"]').text()).toBe(
      'Primary: the first check is primary. Change it here when you add more.',
    );
    w.unmount();
  });

  it('makes the next check primary when the primary is deleted', async () => {
    const checks: TaskFormCheck[] = [
      { key: 'answer', type: 'json_match', primary: true, params: {} },
      {
        key: 'reads_ledger',
        type: 'trajectory_match',
        primary: false,
        params: { tool: 'read_file' },
      },
    ];
    const w = mount(ChecksSection, { props: { ...base, checks }, attachTo: document.body });
    expect(w.text()).toContain('Scored in this order. Drag a card by its handle to change it.');
    await w.get('[aria-label="Delete check answer"]').trigger('click');
    await w
      .findAll('[role="alertdialog"] button')
      .find((b) => b.text() === 'Delete')!
      .trigger('click');
    const [next] = w.emitted('update')![w.emitted('update')!.length - 1] as [TaskFormCheck[]];
    expect(next).toEqual([{ ...checks[1], primary: true }]);
    await w.setProps({ checks: next });
    expect(w.get('[data-testid="primary-note"]').text()).toBe('reads_ledger is now primary.');
    w.unmount();
  });

  it('moves a card with the arrow keys on its handle', async () => {
    const checks: TaskFormCheck[] = [
      { key: 'a', type: 'json_match', primary: true, params: {} },
      { key: 'b', type: 'exact_match', primary: false, params: {} },
    ];
    const w = mount(ChecksSection, { props: { ...base, checks } });
    await w.findAll('[data-drag-handle]')[0]!.trigger('keydown', { key: 'ArrowDown' });
    const [next] = w.emitted('update')![0] as [TaskFormCheck[]];
    expect(next.map((c) => c.key)).toEqual(['b', 'a']);
  });
});
