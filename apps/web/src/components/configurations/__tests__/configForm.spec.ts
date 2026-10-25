import { describe, expect, it } from 'vitest';
import {
  fieldOfIssue,
  formChanges,
  formStateFrom,
  saveState,
  toInput,
  validateForm,
  wholeNumberIn,
  type ConfigFormState,
  type SaveStateInput,
} from '@/components/configurations/configForm';
import {
  CONFIG_VERSIONS,
  draftFixture,
  formOptionsFixture,
  NEW_CONFIGURATION_INPUT,
} from '@/fixtures/configurations';
import { MCP_INVOICE_DB } from '@/fixtures/resources';

const options = formOptionsFixture(false);
const withSkill = () => formStateFrom(draftFixture('edit', CONFIG_VERSIONS['with-skill']).values);
const fresh = () => formStateFrom(NEW_CONFIGURATION_INPUT);

function input(over: Partial<SaveStateInput> & { state: ConfigFormState }): SaveStateInput {
  return {
    mode: 'edit',
    createsNewVersion: true,
    version: 1,
    nextVersion: 2,
    keeping: 3,
    errors: validateForm(over.state),
    changes: [],
    failed: false,
    keyMissing: false,
    ...over,
  };
}

describe('configuration form rules', () => {
  it('reads limits as text and accepts only whole numbers in range', () => {
    expect(wholeNumberIn('20', { min: 1, max: 200 })).toBe(20);
    expect(wholeNumberIn(' 30 ', { min: 1, max: 200 })).toBe(30);
    for (const bad of ['', 'abc', '0', '201', '2.5', '-1']) {
      expect(wholeNumberIn(bad, { min: 1, max: 200 })).toBeNull();
    }
  });

  it('checks the name, the custom base URL and both limits as the API does', () => {
    expect(validateForm(fresh())).toEqual({});
    const bad = {
      ...fresh(),
      name: 'With Skill',
      provider: 'custom' as const,
      baseUrl: 'http://user:pw@host/v1',
      maxTurns: 'abc',
      timeBudgetS: '10',
    };
    expect(validateForm(bad)).toEqual({
      name: 'Use lowercase letters, digits, - and _ (at most 63 characters).',
      baseUrl: 'Enter an http(s) URL without user:password@.',
      maxTurns: 'Enter a whole number from 1 to 200',
      timeBudgetS: 'Enter a whole number from 30 to 3600',
    });
    // An empty name is not an error: Save asks for it instead.
    expect(validateForm({ ...fresh(), name: '' }).name).toBeUndefined();
  });

  it('turns the state into the request body, with a base URL only for custom', () => {
    const body = toInput({ ...withSkill(), maxTurns: '30', baseUrl: 'http://x/v1' });
    expect(body).toMatchObject({
      name: 'with-skill',
      maxTurns: 30,
      timeBudgetS: 300,
      baseUrl: null,
    });
    expect(body.skillIds).toEqual(CONFIG_VERSIONS['with-skill'].skills.map((s) => s.skillId));
    const custom = toInput({
      ...fresh(),
      name: 'mock',
      provider: 'custom',
      baseUrl: ' http://mock-model:8090/v1 ',
    });
    expect(custom.baseUrl).toBe('http://mock-model:8090/v1');
  });

  it('summarises changes as the aside draws them, ignoring order in sets', () => {
    const before = withSkill();
    const after: ConfigFormState = {
      ...before,
      toolsets: ['terminal', 'file', 'memory'],
      memoryEnabled: true,
      maxTurns: '30',
      mcpServerVersionIds: [MCP_INVOICE_DB.versionId],
    };
    expect(formChanges(before, after, options)).toEqual([
      { field: 'toolsets', before: 'file, terminal', after: 'file, terminal, memory' },
      { field: 'memory', before: 'off', after: 'on' },
      { field: 'mcp_servers', before: 'none', after: 'invoice-db' },
      { field: 'max_turns', before: '20', after: '30' },
    ]);
    expect(formChanges(before, { ...before, toolsets: ['terminal', 'file'] }, options)).toEqual([]);
    // A limit that is not a number yet is not a change yet.
    expect(formChanges(before, { ...before, maxTurns: '3x' }, options)).toEqual([]);
  });

  describe('Save', () => {
    it('create: plain Save, disabled until a name and a model are filled', () => {
      const empty = saveState(input({ mode: 'new', state: fresh(), createsNewVersion: false }));
      expect(empty).toEqual({
        label: 'Save',
        disabled: true,
        hint: 'Enter a name, a model and a provider to save.',
        hintTone: 'help',
      });
      const named = { ...fresh(), name: 'or-baseline' };
      expect(saveState(input({ mode: 'new', state: named, createsNewVersion: false }))).toEqual({
        label: 'Save',
        disabled: false,
        hint: 'Creates version 1.',
        hintTone: 'help',
      });
    });

    it('create on a provider without its key: Save stays enabled and says what is left', () => {
      const state = { ...fresh(), name: 'or-baseline', provider: 'openrouter' as const };
      const s = saveState(
        input({ mode: 'new', state, createsNewVersion: false, keyMissing: true }),
      );
      expect([s.disabled, s.hint]).toEqual([
        false,
        'You can save now; add the API key before you launch.',
      ]);
    });

    it('edit of a used version: "Save as version 2", enabled by a change', () => {
      const before = withSkill();
      expect(saveState(input({ state: before }))).toEqual({
        label: 'Save as version 2',
        disabled: true,
        hint: 'Make a change to save a new version.',
        hintTone: 'help',
      });
      const after = { ...before, maxTurns: '30' };
      const changes = formChanges(before, after, options);
      expect(saveState(input({ state: after, changes }))).toEqual({
        label: 'Save as version 2',
        disabled: false,
        hint: 'Version 1 stays frozen for the 3 experiments that used it.',
        hintTone: 'help',
      });
      expect(saveState(input({ state: after, changes, failed: true })).label).toBe(
        'Try again: save as version 2',
      );
    });

    it('names the field to fix before saving', () => {
      const after = { ...withSkill(), maxTurns: '500' };
      const s = saveState(input({ state: after, changes: [] }));
      expect(s).toMatchObject({
        disabled: true,
        hint: 'Fix max turns before saving.',
        hintTone: 'error',
      });
    });

    it('a rename alone keeps the version; an unused version saves in place', () => {
      const before = withSkill();
      const renamed = { ...before, name: 'skill-arm' };
      const changes = formChanges(before, renamed, options);
      expect(saveState(input({ state: renamed, changes }))).toMatchObject({
        label: 'Save',
        hint: 'Renaming keeps version 1.',
      });
      const tuned = { ...before, maxTurns: '25' };
      expect(
        saveState(
          input({
            state: tuned,
            changes: formChanges(before, tuned, options),
            createsNewVersion: false,
            nextVersion: null,
            keeping: 0,
          }),
        ),
      ).toMatchObject({
        label: 'Save',
        disabled: false,
        hint: 'Saves version 1 in place: no experiment has used it yet.',
      });
    });
  });

  it('maps the API issue paths onto the form fields', () => {
    expect(fieldOfIssue('name')).toBe('name');
    expect(fieldOfIssue('maxTurns')).toBe('maxTurns');
    expect(fieldOfIssue('toolsets')).toBe('toolsets');
    expect(fieldOfIssue('mcpServerVersionIds.0')).toBe('resources');
    expect(fieldOfIssue('duplicatedFromVersionId')).toBeNull();
  });
});
