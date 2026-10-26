<script setup lang="ts">
import { computed, useId } from 'vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import FormField from '@/components/ui/FormField.vue';
import SegmentedControl from '@/components/ui/SegmentedControl.vue';
import type { SegmentOption, SelectOption } from '@/components/ui/types';
import type { ConfigurationFormOptions } from '@/api/types/configurations';
import { ROUTE_NAMES } from '@/router';
import type { McpExposure } from '@/stores/configurations';
import ProviderNotice from '@/components/model-access/ProviderNotice.vue';
import ConfigFormRow from './ConfigFormRow.vue';
import McpExposureNote from './McpExposureNote.vue';
import ResourcePicker from './ResourcePicker.vue';
import ToolsetPicker from './ToolsetPicker.vue';
import { mcpDetail, modelHelp } from './configDisplay';
import type { ConfigFormField, ConfigFormIssueField, ConfigFormState } from './configForm';

/**
 * The configuration form's panel (ConfigForm board): Name, Model and provider (with the
 * provider notice), Toolsets, Memory, Skills, Documents, MCP servers (with what each one
 * exposes to the run) and Limits, one ConfigFormRow each. The page owns the values and the
 * rules; `errors` holds the sentences to show (fields the user has left), `blur` says which
 * field was left.
 *
 * Skill loading (Phase 6 P5; no board draws it): once a skill is chosen, the Skills row adds
 * a two-option SegmentedControl, preload or on demand, from the form options, with one line
 * of help. It is drawn like the Comparison's and Experiment list's segment rows.
 */
const props = withDefaults(
  defineProps<{
    options: ConfigurationFormOptions;
    errors?: Partial<Record<ConfigFormIssueField, string>>;
    /** MCP server version id → its env and header names (the resource library). */
    exposure?: Record<string, McpExposure>;
  }>(),
  { errors: () => ({}), exposure: () => ({}) },
);
const state = defineModel<ConfigFormState>({ required: true });
const emit = defineEmits<{ blur: [field: ConfigFormField] }>();

const uid = useId();
const ids = {
  name: `cf-name-${uid}`,
  nameHelp: `cf-name-help-${uid}`,
  models: `cf-models-${uid}`,
  toolsets: `cf-toolsets-${uid}`,
};

function patch(values: Partial<ConfigFormState>): void {
  state.value = { ...state.value, ...values };
}

const help = computed(() => modelHelp(state.value.model, props.options.models));
const providerOptions = computed<SelectOption<string>[]>(() =>
  props.options.providers.map((p) => ({ value: p.id, label: p.label })),
);
const toolsetsLine = computed(() => {
  const on = props.options.toolsets.filter((t) => t.defaultOn).map((t) => t.name);
  const n = props.options.toolsets.length;
  return `${n} toolset${n === 1 ? '' : 's'}${on.length ? ` · default on: ${on.join(', ')}` : ''}.`;
});

// ── skills and documents ──────────────────────────────────────────────────
const skills = computed(() =>
  state.value.skillIds.map((id) => {
    const s = props.options.skills.find((o) => o.skillId === id);
    return { id, label: s?.name ?? id, detail: s?.version ?? null };
  }),
);
const loadingOptions = computed<SegmentOption<ConfigFormState['skillLoading']>[]>(() =>
  props.options.skillLoading.map((o) => ({ value: o.id, label: o.label })),
);
const skillLoading = computed({
  get: () => state.value.skillLoading,
  set: (skillLoading: ConfigFormState['skillLoading']) => patch({ skillLoading }),
});
const skillOptions = computed<SelectOption<string>[]>(() =>
  props.options.skills
    .filter((s) => !state.value.skillIds.includes(s.skillId))
    .map((s) => ({ value: s.skillId, label: `${s.name} · ${s.version}` })),
);
const documents = computed(() =>
  state.value.documentIds.map((id) => {
    const d = props.options.documents.find((o) => o.documentId === id);
    return { id, label: d?.filename ?? id, detail: d?.typeLabel ?? null };
  }),
);
const documentOptions = computed<SelectOption<string>[]>(() =>
  props.options.documents
    .filter((d) => !state.value.documentIds.includes(d.documentId))
    .map((d) => ({ value: d.documentId, label: `${d.filename} · ${d.typeLabel}` })),
);

// ── MCP servers: one version per server; adding a newer one swaps the pin ─
const serverOf = (versionId: string) =>
  props.options.mcpServers.find((m) => m.versionId === versionId);
const servers = computed(() =>
  state.value.mcpServerVersionIds.map((id) => {
    const m = serverOf(id);
    if (!m) return { id, label: id, detail: null, server: null };
    const newer = m.latest
      ? null
      : props.options.mcpServers.find((o) => o.mcpServerId === m.mcpServerId && o.latest);
    return {
      id,
      label: m.name,
      detail: `${mcpDetail(m)}${newer ? ` · v${newer.version} available` : ''}`,
      server: m,
    };
  }),
);
const serverOptions = computed<SelectOption<string>[]>(() =>
  props.options.mcpServers
    .filter((m) => m.latest && !state.value.mcpServerVersionIds.includes(m.versionId))
    .map((m) => {
      const pinned = servers.value.find((s) => s.server?.mcpServerId === m.mcpServerId)?.server;
      return {
        value: m.versionId,
        label: pinned
          ? `${m.name} · ${m.transport} · v${m.version} (replaces v${pinned.version})`
          : `${m.name} · ${m.transport}`,
      };
    }),
);
function addServer(versionId: string): void {
  const m = serverOf(versionId);
  const kept = state.value.mcpServerVersionIds.filter(
    (id) => !m || serverOf(id)?.mcpServerId !== m.mcpServerId,
  );
  patch({ mcpServerVersionIds: [...kept, versionId] });
}

const without = (list: string[], id: string) => list.filter((x) => x !== id);
const libraryTab = (tab: string) => ({ name: ROUTE_NAMES.resourcesTab, params: { tab } });
</script>

<template>
  <form
    class="min-w-0 flex-[999_1_680px] rounded-6 border border-border bg-surface"
    aria-label="Configuration"
    novalidate
    @submit.prevent
  >
    <ConfigFormRow label="Name" :for="ids.name" help="Unique. Used in experiment names and diffs.">
      <div class="flex flex-col gap-4">
        <input
          :id="ids.name"
          :value="state.name"
          class="input max-w-360 font-mono"
          placeholder="e.g. or-baseline"
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="errors.name ? 'true' : undefined"
          :aria-describedby="errors.name ? ids.nameHelp : undefined"
          @input="patch({ name: ($event.target as HTMLInputElement).value })"
          @blur="emit('blur', 'name')"
        />
        <span v-if="errors.name" :id="ids.nameHelp" class="text-12 text-fail-text">{{
          errors.name
        }}</span>
      </div>
    </ConfigFormRow>

    <ConfigFormRow
      label="Model and provider"
      help="Free text is allowed; suggestions come from the price table."
    >
      <div class="flex flex-wrap gap-12">
        <div class="w-320 max-w-full">
          <FormField
            v-slot="{ id, describedBy, invalid, warn }"
            label="Model"
            :help="help.warning ? null : help.text"
            :warning="help.warning ? help.text : null"
            :error="errors.model ?? null"
          >
            <input
              :id="id"
              :value="state.model"
              class="input w-full font-mono"
              :class="{ warn }"
              :list="ids.models"
              placeholder="e.g. openai/gpt-6.1-sol"
              autocomplete="off"
              spellcheck="false"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              @input="patch({ model: ($event.target as HTMLInputElement).value })"
              @blur="emit('blur', 'model')"
            />
            <datalist :id="ids.models">
              <option v-for="m in options.models" :key="m.id" :value="m.id" />
            </datalist>
          </FormField>
        </div>
        <div class="flex w-380 max-w-full flex-col gap-4">
          <FormField v-slot="{ id }" label="Provider">
            <select
              :id="id"
              :value="state.provider"
              class="input w-auto max-w-full min-w-200 font-mono"
              @change="
                patch({
                  provider: ($event.target as HTMLSelectElement)
                    .value as ConfigFormState['provider'],
                })
              "
            >
              <option v-for="o in providerOptions" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select>
          </FormField>
          <!-- Nous: Connected, Not connected or Login needs renewing; an API-key provider:
               Connected, or "No API key." with the .env step. custom has nothing to check. -->
          <ProviderNotice v-if="state.provider !== 'custom'" :provider="state.provider" />
          <FormField
            v-if="state.provider === 'custom'"
            v-slot="{ id, describedBy, invalid }"
            label="Base URL"
            help="An OpenAI-compatible endpoint, e.g. http://mock-model:8090/v1"
            :error="errors.baseUrl ?? null"
          >
            <input
              :id="id"
              :value="state.baseUrl"
              class="input w-full font-mono"
              placeholder="http://…/v1"
              autocomplete="off"
              spellcheck="false"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              @input="patch({ baseUrl: ($event.target as HTMLInputElement).value })"
              @blur="emit('blur', 'baseUrl')"
            />
          </FormField>
        </div>
      </div>
    </ConfigFormRow>

    <ConfigFormRow label="Toolsets" :label-id="ids.toolsets" :help="toolsetsLine">
      <div class="flex max-w-760 flex-col gap-8">
        <ToolsetPicker
          :model-value="state.toolsets"
          :options="options.toolsets"
          :labelledby="ids.toolsets"
          @update:model-value="patch({ toolsets: $event })"
        />
        <p class="text-12 text-text-3">
          Loaded from the runtime. <code>skills</code> and <code>memory</code> are toolsets too:
          turning them off removes the agent's ability to use skills or memory at run time,
          independent of the Skills and Memory fields below.
        </p>
        <span v-if="errors.toolsets" class="text-12 text-fail-text">{{ errors.toolsets }}</span>
      </div>
    </ConfigFormRow>

    <ConfigFormRow label="Memory">
      <div class="flex flex-col gap-6">
        <BaseToggle
          :model-value="state.memoryEnabled"
          :label="state.memoryEnabled ? 'Memory enabled' : 'Memory disabled'"
          @update:model-value="patch({ memoryEnabled: $event })"
        />
        <p class="text-12 text-text-3">
          The Hermes runtime's own default is <b>on</b>. Every run starts in a fresh home, so
          nothing carries between runs either way. This flag only lets the agent write and read
          memory within one run. Default off, so the two configurations differ only where you
          intend.
        </p>
      </div>
    </ConfigFormRow>

    <ConfigFormRow label="Skills">
      <template #help
        >From the resource library. Hermes always loads its own built-in
        <code>hermes-agent</code> skill in every configuration. Skills you add here come on top of
        it.</template
      >
      <div class="flex max-w-760 flex-col gap-8">
        <ResourcePicker
          :items="skills"
          :options="skillOptions"
          placeholder="Add skill…"
          add-label="Add skill"
          :empty-text="null"
          :select-width="180"
          :link="{ label: 'Upload new', to: libraryTab('skills') }"
          @add="patch({ skillIds: [...state.skillIds, $event] })"
          @remove="patch({ skillIds: without(state.skillIds, $event) })"
        />
        <div
          v-if="state.skillIds.length > 0"
          class="flex flex-wrap items-center gap-x-10 gap-y-6"
          data-testid="skill-loading"
        >
          <span class="text-12 font-medium text-text-2" aria-hidden="true">Skill loading</span>
          <SegmentedControl
            v-model="skillLoading"
            :options="loadingOptions"
            label="Skill loading"
          />
          <p class="basis-full text-12 text-text-3">
            Preload puts the skills in the prompt; on demand installs them for the agent to find,
            with the <code>skills</code> toolset.
          </p>
        </div>
        <span v-if="errors.skillLoading" class="text-12 text-fail-text">{{
          errors.skillLoading
        }}</span>
      </div>
    </ConfigFormRow>

    <ConfigFormRow label="Documents">
      <ResourcePicker
        :items="documents"
        :options="documentOptions"
        placeholder="Add document…"
        add-label="Add document"
        :link="{ label: 'Upload new', to: libraryTab('documents') }"
        @add="patch({ documentIds: [...state.documentIds, $event] })"
        @remove="patch({ documentIds: without(state.documentIds, $event) })"
      />
    </ConfigFormRow>

    <ConfigFormRow label="MCP servers">
      <div class="flex max-w-760 flex-col gap-8">
        <ResourcePicker
          :items="servers"
          :options="serverOptions"
          placeholder="Add MCP server…"
          add-label="Add MCP server"
          :link="{ label: 'Define new', to: libraryTab('mcp') }"
          @add="addServer"
          @remove="patch({ mcpServerVersionIds: without(state.mcpServerVersionIds, $event) })"
        />
        <template v-for="s in servers" :key="s.id">
          <McpExposureNote
            v-if="s.server"
            :server="s.server"
            :env-names="exposure[s.id]?.envNames ?? null"
            :headers="exposure[s.id]?.headers ?? null"
            guidance
          />
        </template>
        <span v-if="errors.resources" class="text-12 text-fail-text">{{ errors.resources }}</span>
      </div>
    </ConfigFormRow>

    <ConfigFormRow
      label="Limits"
      help="Every run uses these unless its experiment sets a time budget. Task limits in task.yaml are informational."
    >
      <div class="flex flex-wrap gap-12">
        <div class="w-160">
          <FormField
            v-slot="{ id, describedBy, invalid }"
            label="Max turns"
            help="1 to 200"
            :error="errors.maxTurns ?? null"
          >
            <input
              :id="id"
              :value="state.maxTurns"
              class="input w-full font-mono"
              inputmode="numeric"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              @input="patch({ maxTurns: ($event.target as HTMLInputElement).value })"
              @blur="emit('blur', 'maxTurns')"
            />
          </FormField>
        </div>
        <div class="w-200">
          <FormField
            v-slot="{ id, describedBy, invalid }"
            label="Time budget (s)"
            help="Per run, wall clock"
            :error="errors.timeBudgetS ?? null"
          >
            <input
              :id="id"
              :value="state.timeBudgetS"
              class="input w-full font-mono"
              inputmode="numeric"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              @input="patch({ timeBudgetS: ($event.target as HTMLInputElement).value })"
              @blur="emit('blur', 'timeBudgetS')"
            />
          </FormField>
        </div>
      </div>
    </ConfigFormRow>
  </form>
</template>
