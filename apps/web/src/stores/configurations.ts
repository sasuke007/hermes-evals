/**
 * Configurations: the list rows and the details keyed by configuration id, the form options,
 * and the loaders the three configuration pages call (list with compare, form, detail).
 *
 * Nothing here polls: a configuration changes only when someone saves it, and save() drops
 * what it made stale. The detail of an older version is its own record (`id@v1`), because
 * "view as of this experiment" opens it next to the latest. After a save the detail page
 * says "Saved as version 2" from `lastSaved`, once.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  diffConfigurations,
  getConfiguration,
  getConfigurationDraft,
  getConfigurationFormOptions,
  listConfigurations,
  saveConfiguration,
} from '@/api/configurations';
import { errorMessage } from '@/api/client';
import type {
  ConfigDiff,
  ConfigurationDetail,
  ConfigurationDraft,
  ConfigurationFormOptions,
  ConfigurationInput,
  ConfigurationListRow,
  ConfigurationSaveResult,
} from '@/api/types/configurations';

/** Loading state of one record or list. */
export interface LoadState {
  loading: boolean;
  loaded: boolean;
  /** The failed request, verbatim ("GET /api/configurations → 502 · …"). */
  error: string | null;
}

const idle = (): LoadState => ({ loading: false, loaded: false, error: null });

/** The key of a detail record: the configuration id, plus `@v<n>` for an older version. */
export const detailKey = (id: string, version?: number | null): string =>
  version === undefined || version === null ? id : `${id}@v${version}`;

export const useConfigurationsStore = defineStore('configurations', () => {
  // ── the list ───────────────────────────────────────────────────────────
  const rows = ref<Record<string, ConfigurationListRow>>({});
  const order = ref<string[]>([]);
  const listState = ref<LoadState>(idle());
  /** In the API's order (creation order). */
  const list = computed(() =>
    order.value.map((id) => rows.value[id]).filter((r): r is ConfigurationListRow => !!r),
  );

  // ── details ────────────────────────────────────────────────────────────
  const details = ref<Record<string, ConfigurationDetail>>({});
  const detailStates = ref<Record<string, LoadState>>({});

  // ── the form ───────────────────────────────────────────────────────────
  const formOptions = ref<ConfigurationFormOptions | null>(null);
  const optionsState = ref<LoadState>(idle());

  /** The last save, for the detail page's "Saved as version 2". */
  const lastSaved = ref<ConfigurationSaveResult | null>(null);

  const diffs = new Map<string, ConfigDiff>();

  /** A configuration's name from whatever is loaded, for titles before its detail arrives. */
  function nameOf(id: string): string | null {
    return rows.value[id]?.name ?? details.value[id]?.name ?? null;
  }

  /** GET /configurations. Keeps the last good list on failure. */
  async function loadList(): Promise<void> {
    listState.value = { ...listState.value, loading: true };
    try {
      const next = await listConfigurations();
      rows.value = Object.fromEntries(next.map((r) => [r.id, r]));
      order.value = next.map((r) => r.id);
      listState.value = { loading: false, loaded: true, error: null };
    } catch (err) {
      listState.value = { ...listState.value, loading: false, error: errorMessage(err) };
    }
  }

  function detailState(id: string, version?: number | null): LoadState {
    return detailStates.value[detailKey(id, version)] ?? idle();
  }

  function detail(id: string, version?: number | null): ConfigurationDetail | null {
    return details.value[detailKey(id, version)] ?? null;
  }

  /** GET /configurations/:id, or /configurations/:id/versions/:v for an older version. */
  async function loadDetail(id: string, version?: number | null): Promise<void> {
    const key = detailKey(id, version);
    detailStates.value[key] = { ...detailState(id, version), loading: true };
    try {
      const found = await getConfiguration(id, version ?? undefined);
      details.value[key] = found;
      if (rows.value[id] && version == null) {
        rows.value[id] = { ...rows.value[id], name: found.name, latest: found.latest };
      }
      detailStates.value[key] = { loading: false, loaded: true, error: null };
    } catch (err) {
      detailStates.value[key] = {
        ...detailState(id, version),
        loading: false,
        error: errorMessage(err),
      };
    }
  }

  /** GET /configurations/form-options. Rejects, so the form can show why it cannot open. */
  async function loadFormOptions(): Promise<ConfigurationFormOptions> {
    optionsState.value = { ...optionsState.value, loading: true };
    try {
      const options = await getConfigurationFormOptions();
      formOptions.value = options;
      optionsState.value = { loading: false, loaded: true, error: null };
      return options;
    } catch (err) {
      optionsState.value = { ...optionsState.value, loading: false, error: errorMessage(err) };
      throw err;
    }
  }

  /** The form's starting draft: new, edit or duplicate. Not kept: each visit starts fresh. */
  function fetchDraft(mode: ConfigurationDraft['mode'], id?: string): Promise<ConfigurationDraft> {
    return getConfigurationDraft(mode, id);
  }

  /** GET /configurations/diff for two or three version ids, remembered per selection. */
  async function diff(versionIds: string[]): Promise<ConfigDiff> {
    const key = versionIds.join(',');
    const known = diffs.get(key);
    if (known) return known;
    const found = await diffConfigurations(versionIds);
    diffs.set(key, found);
    return found;
  }

  /**
   * POST or PUT. Rejects with the ApiError (the form shows its message and issues). On
   * success the list and this configuration's details are reloaded on their next visit.
   */
  async function save(input: ConfigurationInput, id?: string): Promise<ConfigurationSaveResult> {
    const result = await saveConfiguration(input, id);
    lastSaved.value = result;
    diffs.clear();
    for (const key of Object.keys(details.value)) {
      if (key === result.configurationId || key.startsWith(`${result.configurationId}@`)) {
        delete details.value[key];
        delete detailStates.value[key];
      }
    }
    listState.value = { ...listState.value, loaded: false };
    return result;
  }

  /** Reads and forgets the save notice for one configuration. */
  function takeSaved(configurationId: string): ConfigurationSaveResult | null {
    const saved = lastSaved.value;
    if (!saved || saved.configurationId !== configurationId) return null;
    lastSaved.value = null;
    return saved;
  }

  return {
    // state
    rows,
    order,
    listState,
    details,
    detailStates,
    formOptions,
    optionsState,
    lastSaved,
    // getters
    list,
    // actions
    nameOf,
    loadList,
    detail,
    detailState,
    loadDetail,
    loadFormOptions,
    fetchDraft,
    diff,
    save,
    takeSaved,
  };
});
