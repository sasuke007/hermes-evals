<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useEventListener } from '@vueuse/core';
import ConfigFormFields from '@/components/configurations/ConfigFormFields.vue';
import ConfigSaveAside from '@/components/configurations/ConfigSaveAside.vue';
import { joinSeries } from '@/components/configurations/configDisplay';
import {
  fieldOfIssue,
  formChanges,
  formStateFrom,
  saveState,
  toInput,
  validateForm,
  type ConfigFormErrors,
  type ConfigFormField,
  type ConfigFormIssueField,
  type ConfigFormState,
  type SaveState,
} from '@/components/configurations/configForm';
import PageContainer from '@/components/layout/PageContainer.vue';
import BaseBreadcrumb from '@/components/ui/BaseBreadcrumb.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { errorMessage, isApiError } from '@/api/client';
import type { ConfigurationDraft } from '@/api/types/configurations';
import { ROUTE_NAMES } from '@/router';
import { useConfigurationsStore } from '@/stores/configurations';
import { useProvidersStore } from '@/stores/providers';
import { plural } from '@/lib/format';

/**
 * The configuration form (ConfigForm and ConfigFormStates boards; UI_FLOWS 10.1).
 *   new        /configurations/new: GET /configurations/new-draft, saves version 1
 *   duplicate  /configurations/new?from=<id>: POST /configurations/:id/duplicate prefills it;
 *              nothing is stored until Save
 *   edit       /configurations/:id/edit: GET /configurations/:id/draft. On a version an
 *              experiment used, the banner says saving creates the next version and which
 *              experiments keep this one, and the button reads "Save as version 2".
 * Saving never calls a model, so provider status never blocks it. A failed save keeps every
 * value and the button retries; on success the page routes to the detail ("Saved as version
 * 2"). Fields are checked when left (on blur) and all at once on Save.
 */
const props = defineProps<{ mode: 'new' | 'edit' | 'duplicate'; configurationId?: string }>();

const store = useConfigurationsStore();
const providers = useProvidersStore();
const router = useRouter();

const draft = ref<ConfigurationDraft | null>(null);
const initial = ref<ConfigFormState | null>(null);
const state = ref<ConfigFormState | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
/** Fields the user has left: their errors show. */
const touched = ref<ConfigFormField[]>([]);
const busy = ref(false);
const saveError = ref<string | null>(null);
const failed = ref(false);
/** The API's 400 issues per field, from the last save. */
const serverIssues = ref<Partial<Record<ConfigFormIssueField, string>>>({});

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  draft.value = null;
  state.value = null;
  touched.value = [];
  saveError.value = null;
  failed.value = false;
  serverIssues.value = {};
  try {
    const [next] = await Promise.all([
      store.fetchDraft(props.mode, props.configurationId),
      store.loadFormOptions(),
    ]);
    draft.value = next;
    initial.value = formStateFrom(next.values);
    state.value = formStateFrom(next.values);
  } catch (err) {
    loadError.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}
watch(() => [props.mode, props.configurationId], load, { immediate: true });

onMounted(() => {
  if (!providers.loaded) void providers.load();
  void store.loadMcpExposure();
});
// "Upload new" and "Define new" open the library in a new tab: pick up what was added there.
useEventListener(window, 'focus', () => {
  if (!draft.value) return;
  store.loadFormOptions().catch(() => {});
  void store.loadMcpExposure();
});

const options = computed(() => store.formOptions);
const source = computed(() => draft.value?.source ?? null);
const errors = computed<ConfigFormErrors>(() => (state.value ? validateForm(state.value) : {}));
const shownErrors = computed(() => {
  const shown: Partial<Record<ConfigFormIssueField, string>> = {
    ...serverIssues.value,
  };
  for (const field of touched.value) {
    const message = errors.value[field];
    if (message) shown[field] = message;
  }
  return shown;
});
const changes = computed(() => {
  if (!state.value || !initial.value) return [];
  const all = formChanges(initial.value, state.value, options.value);
  // A duplicate is renamed from "<name>-copy" by design; the summary is about settings.
  return props.mode === 'duplicate' ? all.filter((c) => c.field !== 'name') : all;
});
const keyMissing = computed(() => {
  const provider = state.value?.provider;
  if (!provider || provider === 'custom' || provider === 'nous') return false;
  return providers.providers.find((p) => p.id === provider)?.status === 'missing';
});
const save = computed<SaveState>(() => {
  if (!state.value) return { label: 'Save', disabled: true, hint: '', hintTone: 'help' };
  return saveState({
    mode: props.mode,
    createsNewVersion: draft.value?.createsNewVersion ?? false,
    version: source.value?.version ?? null,
    nextVersion: draft.value?.nextVersion ?? null,
    keeping: draft.value?.experimentsKeepingVersion.length ?? 0,
    state: state.value,
    errors: errors.value,
    changes: changes.value,
    failed: failed.value,
    keyMissing: keyMissing.value,
  });
});

function onBlur(field: ConfigFormField): void {
  if (!touched.value.includes(field)) touched.value = [...touched.value, field];
}

async function onSave(): Promise<void> {
  if (!state.value) return;
  touched.value = ['name', 'model', 'baseUrl', 'maxTurns', 'timeBudgetS'];
  if (save.value.disabled || busy.value) return;
  busy.value = true;
  saveError.value = null;
  serverIssues.value = {};
  try {
    const result = await store.save(
      toInput(state.value),
      props.mode === 'edit' ? props.configurationId : undefined,
    );
    await router.push({ name: ROUTE_NAMES.configuration, params: { id: result.configurationId } });
  } catch (err) {
    failed.value = true;
    saveError.value = errorMessage(err);
    if (isApiError(err)) {
      const issues: typeof serverIssues.value = {};
      for (const issue of err.issues) {
        const field = fieldOfIssue(issue.path);
        if (field && !issues[field]) issues[field] = issue.message;
      }
      serverIssues.value = issues;
    }
  } finally {
    busy.value = false;
  }
}

// ── header, banner and aside copy ─────────────────────────────────────────
const list = { label: 'Configurations', to: { name: ROUTE_NAMES.configurations } };
const breadcrumbs = computed<BreadcrumbItem[]>(() => {
  if (props.mode !== 'edit') return [list, { label: 'New' }];
  const name = source.value?.name ?? store.nameOf(props.configurationId ?? '') ?? 'Configuration';
  return [
    list,
    { label: name, to: { name: ROUTE_NAMES.configuration, params: { id: props.configurationId } } },
    { label: 'Edit' },
  ];
});
const sourceRoute = computed(() =>
  source.value
    ? { name: ROUTE_NAMES.configuration, params: { id: source.value.configurationId } }
    : null,
);
/** "with-skill v1 has been used by 3 experiments. Saving creates version 2. …" */
const banner = computed(() => {
  const d = draft.value;
  if (props.mode !== 'edit' || !d?.createsNewVersion || !d.source) return null;
  const keeping = d.experimentsKeepingVersion.map((e) => e.name);
  const v = d.source.version;
  return {
    lead: `${d.source.name} v${v} has been used by ${plural(keeping.length, 'experiment')}.`,
    next: `version ${d.nextVersion ?? v + 1}`,
    keep: keeping.length
      ? `${joinSeries(keeping)} ${keeping.length === 1 ? 'keeps' : 'keep'} version ${v}.`
      : '',
  };
});
const asideTitle = computed(() =>
  props.mode === 'edit' && source.value
    ? `Changes from v${source.value.version}`
    : 'New configuration',
);
const cancelTo = computed(() => {
  if (props.mode === 'edit') {
    return { name: ROUTE_NAMES.configuration, params: { id: props.configurationId } };
  }
  return sourceRoute.value ?? { name: ROUTE_NAMES.configurations };
});
const loadErrorTitle = computed(() =>
  props.mode === 'edit' ? 'Could not load this configuration' : 'Could not load the form',
);
</script>

<template>
  <PageContainer variant="detail">
    <div class="flex flex-col gap-4">
      <BaseBreadcrumb :items="breadcrumbs" />
      <div v-if="mode === 'edit'" class="flex items-center gap-10">
        <h1 class="text-20 font-semibold">
          Edit <span class="font-mono">{{ breadcrumbs[1]?.label }}</span>
        </h1>
        <span v-if="source" class="tag">v{{ source.version }}</span>
      </div>
      <h1 v-else class="text-20 font-semibold">New configuration</h1>
      <p v-if="mode === 'duplicate' && source && sourceRoute" class="text-12 text-text-3">
        Duplicated from
        <RouterLink :to="sourceRoute" class="font-mono">{{ source.name }}</RouterLink>
        v{{ source.version }}. Nothing is stored until you save.
      </p>
    </div>

    <ErrorBanner
      v-if="loadError"
      :title="loadErrorTitle"
      :detail="loadError"
      retry-label="Retry"
      @retry="load"
    />

    <div v-else-if="loading || !state || !options" class="flex flex-wrap items-start gap-20">
      <div
        class="min-w-0 flex-[999_1_680px] rounded-6 border border-border bg-surface p-20"
        aria-busy="true"
        data-testid="form-loading"
      >
        <SkeletonRows
          :columns="[{ width: ['40%', '70%', '55%', '85%', '30%', '60%'] }]"
          layout="lines"
          :rows="8"
        />
      </div>
    </div>

    <template v-else>
      <div
        v-if="banner"
        role="status"
        class="flex items-start gap-12 rounded-6 border border-border-strong bg-accent-soft px-14 py-12"
        data-testid="version-banner"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
          class="mt-2 flex-none text-accent"
        >
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path
            d="M8 7.2v4M8 4.8h.01"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <div class="text-text-2">
          <b class="text-text">{{ banner.lead }}</b> Saving creates
          <b class="text-text">{{ banner.next }}</b
          >. {{ banner.keep }} New experiments use the latest version.
        </div>
      </div>

      <div class="flex flex-wrap items-start gap-20">
        <ConfigFormFields
          v-model="state"
          :options="options"
          :errors="shownErrors"
          :exposure="store.mcpExposure"
          @blur="onBlur"
        />
        <ConfigSaveAside
          :title="asideTitle"
          :intro="
            mode === 'edit'
              ? null
              : 'Saving creates version 1. Fields can be changed later; each saved change used by an experiment becomes a new version.'
          "
          :changes="mode === 'new' ? null : changes"
          :changes-title="
            mode === 'duplicate' && source ? `Changes from ${source.name} v${source.version}` : null
          "
          :error="saveError"
          :save="save"
          :busy="busy"
          :cancel-to="cancelTo"
          @save="onSave"
        />
      </div>
    </template>
  </PageContainer>
</template>
