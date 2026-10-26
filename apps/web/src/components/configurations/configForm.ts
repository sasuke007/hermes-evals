/**
 * The configuration form's state and rules (ConfigForm and ConfigFormStates boards, plan
 * section 6): the values as the inputs hold them (limits as text, so "abc" can be shown and
 * refused), the field rules ConfigurationInputSchema applies on the server, the change summary
 * in the aside, and what Save says and whether it is enabled. Pure functions, so the page
 * stays small and each rule is tested on its own.
 */
import {
  HTTP_URL_PATTERN,
  SKILL_LOADING_LABELS,
  SLUG_PATTERN,
  type Provider,
  type SkillLoadingMode,
} from '@hermes-evals/shared';
import type {
  ConfigurationDraft,
  ConfigurationFormOptions,
  ConfigurationInput,
} from '@/api/types/configurations';
import { plural } from '@/lib/format';
import { skillLabel } from './configDisplay';

export type ConfigFormMode = ConfigurationDraft['mode'];

/** The form's values, as its inputs hold them. */
export interface ConfigFormState {
  name: string;
  model: string;
  provider: Provider;
  /** Only for provider `custom`. */
  baseUrl: string;
  toolsets: string[];
  memoryEnabled: boolean;
  skillIds: string[];
  /**
   * Phase 6 P5. The form offers the choice only while skills are chosen, and keeps it when the
   * last skill is removed, so adding one back restores it; without skills it saves `preload`.
   */
  skillLoading: SkillLoadingMode;
  documentIds: string[];
  mcpServerVersionIds: string[];
  maxTurns: string;
  timeBudgetS: string;
  duplicatedFromVersionId: string | null;
}

/** Fields with a rule of their own; their error shows under the control. */
export type ConfigFormField = 'name' | 'model' | 'baseUrl' | 'maxTurns' | 'timeBudgetS';
export type ConfigFormErrors = Partial<Record<ConfigFormField, string>>;
/** Where a 400's issue shows: a field, the toolsets, the skill loading choice or the resources. */
export type ConfigFormIssueField = ConfigFormField | 'toolsets' | 'skillLoading' | 'resources';

export const MAX_TURNS = { min: 1, max: 200 } as const;
export const TIME_BUDGET_S = { min: 30, max: 3600 } as const;

export function formStateFrom(values: ConfigurationDraft['values']): ConfigFormState {
  return {
    name: values.name,
    model: values.model,
    provider: values.provider,
    baseUrl: values.baseUrl ?? '',
    toolsets: [...values.toolsets],
    memoryEnabled: values.memoryEnabled,
    skillIds: [...values.skillIds],
    skillLoading: values.skillLoading,
    documentIds: [...values.documentIds],
    mcpServerVersionIds: [...values.mcpServerVersionIds],
    maxTurns: String(values.maxTurns),
    timeBudgetS: String(values.timeBudgetS),
    duplicatedFromVersionId: values.duplicatedFromVersionId,
  };
}

/** "20" → 20; anything that is not a whole number within the bounds → null. */
export function wholeNumberIn(text: string, bounds: { min: number; max: number }): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= bounds.min && n <= bounds.max ? n : null;
}

/**
 * The skill loading the configuration saves: the chosen mode with skills, `preload` without,
 * which is the only mode a configuration without skills can have (a 400 otherwise).
 */
export const effectiveSkillLoading = (
  state: Pick<ConfigFormState, 'skillIds' | 'skillLoading'>,
): SkillLoadingMode => (state.skillIds.length > 0 ? state.skillLoading : 'preload');

/** The request body. Call it on a state validateForm accepts. */
export function toInput(state: ConfigFormState): ConfigurationInput {
  return {
    name: state.name.trim(),
    model: state.model.trim(),
    provider: state.provider,
    baseUrl: state.provider === 'custom' ? state.baseUrl.trim() : null,
    toolsets: [...state.toolsets],
    memoryEnabled: state.memoryEnabled,
    skillIds: [...state.skillIds],
    skillLoading: effectiveSkillLoading(state),
    documentIds: [...state.documentIds],
    mcpServerVersionIds: [...state.mcpServerVersionIds],
    maxTurns: Number(state.maxTurns.trim()),
    timeBudgetS: Number(state.timeBudgetS.trim()),
    duplicatedFromVersionId: state.duplicatedFromVersionId,
  };
}

/** True while the name or the model is still empty: Save asks for them, no field turns red. */
export function isMissing(state: ConfigFormState): boolean {
  return state.name.trim() === '' || state.model.trim() === '';
}

/**
 * Every rule a value breaks, with the sentence shown under its field. An empty name or model
 * is not an error here (isMissing covers it): a new form is not red before it is touched.
 */
export function validateForm(state: ConfigFormState): ConfigFormErrors {
  const errors: ConfigFormErrors = {};
  const name = state.name.trim();
  if (name !== '' && !SLUG_PATTERN.test(name)) {
    errors.name = 'Use lowercase letters, digits, - and _ (at most 63 characters).';
  }
  if (state.provider === 'custom' && !HTTP_URL_PATTERN.test(state.baseUrl.trim())) {
    errors.baseUrl = 'Enter an http(s) URL without user:password@.';
  }
  if (wholeNumberIn(state.maxTurns, MAX_TURNS) === null) {
    errors.maxTurns = `Enter a whole number from ${MAX_TURNS.min} to ${MAX_TURNS.max}`;
  }
  if (wholeNumberIn(state.timeBudgetS, TIME_BUDGET_S) === null) {
    errors.timeBudgetS = `Enter a whole number from ${TIME_BUDGET_S.min} to ${TIME_BUDGET_S.max}`;
  }
  return errors;
}

/** One line of the aside: "max_turns 20 → 30". */
export interface ConfigChange {
  /** The field as ConfigDiffTable names it: name, model, toolsets, max_turns, base_url… */
  field: string;
  before: string;
  after: string;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v) => b.includes(v));

/** Names for the ids the form holds, from the form options; an unknown id shows as itself. */
function labeller(options: ConfigurationFormOptions | null) {
  const skills = new Map(options?.skills.map((s) => [s.skillId, skillLabel(s)]));
  const documents = new Map(options?.documents.map((d) => [d.documentId, d.filename]));
  const servers = new Map(options?.mcpServers.map((m) => [m.versionId, m.name]));
  const toolOrder = options?.toolsets.map((t) => t.name) ?? [];
  const list = (ids: readonly string[], names: Map<string, string>) =>
    ids.map((id) => names.get(id) ?? id).join(', ') || 'none';
  return {
    toolsets: (names: readonly string[]) => {
      const rank = (t: string) => {
        const i = toolOrder.indexOf(t);
        return i === -1 ? toolOrder.length : i;
      };
      return [...names].sort((a, b) => rank(a) - rank(b)).join(', ') || 'none';
    },
    skills: (ids: readonly string[]) => list(ids, skills),
    documents: (ids: readonly string[]) => list(ids, documents),
    servers: (ids: readonly string[]) => list(ids, servers),
  };
}

/**
 * What differs between where the form started and what it holds now, in ConfigDiffTable's
 * field order. Sets (toolsets, skills, documents, MCP servers) ignore order; a limit that is
 * not a valid number yet is left out until it is.
 */
export function formChanges(
  before: ConfigFormState,
  after: ConfigFormState,
  options: ConfigurationFormOptions | null,
): ConfigChange[] {
  const label = labeller(options);
  const changes: ConfigChange[] = [];
  const add = (field: string, a: string, b: string) => {
    if (a !== b) changes.push({ field, before: a, after: b });
  };
  add('name', before.name.trim() || '—', after.name.trim() || '—');
  add('model', before.model.trim() || '—', after.model.trim() || '—');
  add('provider', before.provider, after.provider);
  const url = (s: ConfigFormState) => (s.provider === 'custom' ? s.baseUrl.trim() || '—' : '—');
  add('base_url', url(before), url(after));
  if (!sameSet(before.toolsets, after.toolsets)) {
    add('toolsets', label.toolsets(before.toolsets), label.toolsets(after.toolsets));
  }
  add('memory', before.memoryEnabled ? 'on' : 'off', after.memoryEnabled ? 'on' : 'off');
  if (!sameSet(before.skillIds, after.skillIds)) {
    add('skills', label.skills(before.skillIds), label.skills(after.skillIds));
  }
  add(
    'skill_loading',
    SKILL_LOADING_LABELS[effectiveSkillLoading(before)],
    SKILL_LOADING_LABELS[effectiveSkillLoading(after)],
  );
  if (!sameSet(before.documentIds, after.documentIds)) {
    add('documents', label.documents(before.documentIds), label.documents(after.documentIds));
  }
  if (!sameSet(before.mcpServerVersionIds, after.mcpServerVersionIds)) {
    add(
      'mcp_servers',
      label.servers(before.mcpServerVersionIds),
      label.servers(after.mcpServerVersionIds),
    );
  }
  const limit = (field: string, a: string, b: string, bounds: { min: number; max: number }) => {
    const x = wholeNumberIn(a, bounds);
    const y = wholeNumberIn(b, bounds);
    if (y !== null) add(field, x === null ? a.trim() : String(x), String(y));
  };
  limit('max_turns', before.maxTurns, after.maxTurns, MAX_TURNS);
  limit('time_budget_s', before.timeBudgetS, after.timeBudgetS, TIME_BUDGET_S);
  return changes;
}

/** What the Save button says and does, and the line under it. */
export interface SaveState {
  label: string;
  disabled: boolean;
  hint: string;
  /** error: the hint names a field to fix (orange). */
  hintTone: 'help' | 'error';
}

export interface SaveStateInput {
  mode: ConfigFormMode;
  /** Edit of a version an experiment used: a change of settings saves the next version. */
  createsNewVersion: boolean;
  /** The version being edited (draft.source.version). */
  version: number | null;
  nextVersion: number | null;
  /** How many experiments keep the edited version. */
  keeping: number;
  state: ConfigFormState;
  errors: ConfigFormErrors;
  changes: ConfigChange[];
  /** The last save failed: the button retries. */
  failed: boolean;
  /** The provider is an API-key provider whose key is not set on the server. */
  keyMissing: boolean;
}

const FIX: Record<ConfigFormField, string> = {
  name: 'Fix the name before saving.',
  model: 'Enter a model before saving.',
  baseUrl: 'Fix the base URL before saving.',
  maxTurns: 'Fix max turns before saving.',
  timeBudgetS: 'Fix the time budget before saving.',
};
const FIX_ORDER: ConfigFormField[] = ['maxTurns', 'timeBudgetS', 'baseUrl', 'name', 'model'];

/**
 * Save (ConfigForm board): create mode saves version 1 and stays disabled until a name and a
 * model are filled; an edit needs a change, and an edit of a used version reads "Save as
 * version 2" and says which version stays frozen. Provider status never disables it.
 */
export function saveState(input: SaveStateInput): SaveState {
  const { mode, errors, changes, state } = input;
  const fix = FIX_ORDER.find((f) => errors[f]);
  const blocked = (hint: string, hintTone: SaveState['hintTone'], label: string): SaveState => ({
    label,
    disabled: true,
    hint,
    hintTone,
  });

  if (mode !== 'edit') {
    const label = 'Save';
    if (isMissing(state)) {
      return blocked('Enter a name, a model and a provider to save.', 'help', label);
    }
    if (fix) return blocked(FIX[fix], 'error', label);
    return {
      label,
      disabled: false,
      hint: input.keyMissing
        ? 'You can save now; add the API key before you launch.'
        : 'Creates version 1.',
      hintTone: 'help',
    };
  }

  const settingsChanged = changes.some((c) => c.field !== 'name');
  // A rename alone renames: the version stays. Before any change the button already says
  // what a change will do ("Save as version 2", disabled).
  const renameOnly = changes.length > 0 && !settingsChanged;
  const newVersion = input.createsNewVersion && !renameOnly;
  const next = input.nextVersion ?? (input.version ?? 0) + 1;
  const label = newVersion
    ? input.failed
      ? `Try again: save as version ${next}`
      : `Save as version ${next}`
    : 'Save';
  if (isMissing(state)) {
    return blocked('Enter a name, a model and a provider to save.', 'help', label);
  }
  if (fix) return blocked(FIX[fix], 'error', label);
  if (changes.length === 0) {
    return blocked(
      input.createsNewVersion ? 'Make a change to save a new version.' : 'Make a change to save.',
      'help',
      label,
    );
  }
  const v = input.version ?? 1;
  let hint: string;
  if (newVersion) {
    hint =
      input.keeping > 0
        ? `Version ${v} stays frozen for the ${plural(input.keeping, 'experiment')} that used it.`
        : `Version ${v} stays frozen.`;
  } else if (input.createsNewVersion) {
    hint = `Renaming keeps version ${v}.`;
  } else {
    hint = `Saves version ${v} in place: no experiment has used it yet.`;
  }
  return { label, disabled: false, hint, hintTone: 'help' };
}

/**
 * The shared request schema's issue paths (ApiError.issues on a 400) mapped onto the form's
 * fields; anything else goes to the aside's error.
 */
export function fieldOfIssue(path: string): ConfigFormIssueField | null {
  const head = path.split('.')[0] ?? '';
  if (head === 'name' || head === 'model' || head === 'baseUrl') return head;
  if (head === 'maxTurns' || head === 'timeBudgetS') return head;
  if (head === 'toolsets') return 'toolsets';
  if (head === 'skillLoading') return 'skillLoading';
  if (head === 'skillIds' || head === 'documentIds' || head === 'mcpServerVersionIds') {
    return 'resources';
  }
  return null;
}
