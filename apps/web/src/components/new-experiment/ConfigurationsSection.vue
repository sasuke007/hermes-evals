<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { RouterLink } from 'vue-router';
import ConfigDiffTable from '@/components/configurations/ConfigDiffTable.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import { ROUTE_NAMES } from '@/router';
import { useExperimentsStore } from '@/stores/experiments';
import { missingSecretText } from '@hermes-evals/shared';
import FormSection from './FormSection.vue';
import { providerTag, unsetSecrets, type ProviderSnapshot } from './launchReadiness';
import { useFormContext } from './useNewExperimentForm';

/**
 * Section 3, Configurations (NewExperiment board): tick two or more, the radio marks the
 * baseline, the others are candidates. A row whose provider is not ready carries an amber tag
 * ("Nous Portal not connected", "OpenRouter key missing"). "Compare side by side" opens the
 * shared ConfigDiffTable (GET /configurations/diff, baseline first) with the count of fields
 * that differ, which is how the user checks the experiment is controlled. With fewer than two
 * configurations it says how to make a second one (ExperimentStates).
 *
 * Phase 6: a row whose MCP servers name a variable that is not set carries one amber tag per
 * variable, drawn like the provider tag ("INVOICE_DB_URL not set · invoice-db", the full
 * sentence on hover); while no worker is live there are none, the no-worker block says why.
 * Skills loaded on demand read "1 · on demand" in the Skills column.
 */
const props = withDefaults(defineProps<{ providers: ProviderSnapshot; noWorker?: boolean }>(), {
  noWorker: false,
});
const form = useFormContext();
const store = useExperimentsStore();

const compareOpen = ref(true);
const compareId = `ne-compare-${useId()}`;

const rows = computed(() =>
  form.configurations.value.map((c) => {
    const role = form.roleOf(c.versionId);
    return {
      option: c,
      role,
      on: role !== 'not included',
      tag: providerTag(props.providers, c.provider),
      secrets: unsetSecrets(c, { noWorker: props.noWorker }),
      onDemand: c.skills.length > 0 && c.skillLoading === 'on_demand',
    };
  }),
);

const ROLE_CLASSES = {
  baseline: 'bg-surface-3 text-text font-semibold',
  candidate: 'bg-accent-soft text-accent',
  'not included': 'bg-surface-2 text-text-3',
} as const;

const versionIds = computed(() => form.ordered.value.map((c) => c.versionId));
const roles = computed(() => store.diff?.columns.map((col) => form.roleOf(col.versionId)) ?? null);
watch(
  [versionIds, compareOpen],
  ([ids, open]) => {
    if (open) void store.loadDiff(ids);
  },
  { immediate: true },
);

/** Fewer than two exist: the way to a second one. */
const onlyOne = computed(() => form.configurations.value.length < 2);
const first = computed(() => form.configurations.value[0] ?? null);
</script>

<template>
  <FormSection :number="3" title="Configurations">
    <template #caption
      >Pick two or more. Mark one as the baseline; the others are candidates.</template
    >
    <div v-if="rows.length > 0" class="overflow-x-auto rounded-4 border border-border">
      <table class="dt inset14" aria-label="Configurations">
        <thead>
          <tr>
            <th class="w-36"><span class="sr-only">Include</span></th>
            <th>Configuration</th>
            <th>Baseline</th>
            <th>Model</th>
            <th class="text-right">Skills</th>
            <th class="text-right">MCP servers</th>
            <th>Memory</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.option.versionId"
            :class="{ 'text-text-3': !row.on }"
            :data-config="row.option.name"
            :data-role="row.role"
          >
            <td class="w-36">
              <input
                type="checkbox"
                class="size-14 accent-accent"
                :checked="row.on"
                :aria-label="`Include ${row.option.name}`"
                @change="
                  form.toggleConfiguration(
                    row.option.versionId,
                    ($event.target as HTMLInputElement).checked,
                  )
                "
              />
            </td>
            <td>
              <span class="inline-flex flex-wrap items-center gap-6">
                <span class="font-mono text-12 font-semibold">{{ row.option.name }}</span>
                <span class="tag">v{{ row.option.version }}</span>
                <span
                  v-if="row.tag"
                  class="inline-flex h-18 items-center gap-4 rounded-3 bg-ung-soft px-6 text-11 font-medium whitespace-nowrap text-ung-text"
                  data-testid="provider-tag"
                  ><StatusDot tone="ung" mode="hollow" />{{ row.tag }}</span
                >
                <span
                  v-for="m in row.secrets"
                  :key="`${m.server}:${m.name}`"
                  class="inline-flex h-18 items-center gap-4 rounded-3 bg-ung-soft px-6 text-11 font-medium whitespace-nowrap text-ung-text"
                  :title="`${missingSecretText(m)} is not set`"
                  data-testid="secret-tag"
                  ><StatusDot tone="ung" mode="hollow" /><span class="font-mono">{{ m.name }}</span>
                  not set · {{ m.server }}</span
                >
              </span>
            </td>
            <td>
              <input
                type="radio"
                name="ne-baseline"
                class="size-14 accent-accent"
                :checked="row.role === 'baseline'"
                :aria-label="`Use ${row.option.name} as baseline`"
                @change="form.makeBaseline(row.option.versionId)"
              />
            </td>
            <td class="font-mono text-12">{{ row.option.model }}</td>
            <td class="text-right whitespace-nowrap">
              {{ row.option.skills.length
              }}<span v-if="row.onDemand" class="text-text-3" data-testid="on-demand">
                · on demand</span
              >
            </td>
            <td class="text-right">{{ row.option.mcpServers.length }}</td>
            <td>{{ row.option.memoryEnabled ? 'on' : 'off' }}</td>
            <td>
              <span class="chip" :class="ROLE_CLASSES[row.role]" data-testid="role">{{
                row.role
              }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="onlyOne"
      role="status"
      class="flex flex-col gap-6 rounded-4 border border-border bg-surface-2 px-12 py-10"
      data-testid="too-few-configurations"
    >
      <span class="text-text-2"
        >An experiment compares a baseline with at least one candidate, and
        {{ first ? 'only one configuration exists' : 'no configuration exists yet' }}.</span
      >
      <div class="flex flex-wrap gap-8">
        <RouterLink
          v-if="first"
          :to="{
            name: ROUTE_NAMES.configurationNew,
            query: { from: first.configurationId },
          }"
          class="btn sm"
          >Duplicate {{ first.name }}</RouterLink
        >
        <RouterLink :to="{ name: ROUTE_NAMES.configurationNew }" class="btn sm"
          >New configuration</RouterLink
        >
      </div>
    </div>

    <div v-else class="flex flex-col gap-8">
      <button
        type="button"
        class="btn sm self-start"
        :aria-expanded="compareOpen ? 'true' : 'false'"
        :aria-controls="compareId"
        @click="compareOpen = !compareOpen"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          class="transition-transform"
          :class="{ 'rotate-90': compareOpen }"
        >
          <path
            d="M4 2.5L7.5 6 4 9.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        Compare side by side
      </button>
      <div v-if="compareOpen" :id="compareId" class="flex flex-col gap-8">
        <ErrorBanner
          v-if="store.diffError"
          compact
          title="Could not compare the configurations"
          :detail="store.diffError"
          retry-label="Retry"
          @retry="store.loadDiff(versionIds)"
        />
        <ConfigDiffTable
          v-else
          :diff="versionIds.length >= 2 ? store.diff : null"
          variant="inline"
          :roles="roles"
        />
      </div>
    </div>
  </FormSection>
</template>
