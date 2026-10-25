<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { errorMessage } from '@/api/client';
import type {
  ConfigDiff,
  ConfigurationDetail,
  ConfigurationListRow,
} from '@/api/types/configurations';
import { useConfigurationsStore } from '@/stores/configurations';
import ConfigDiffTable from './ConfigDiffTable.vue';

/**
 * ConfigDetail › "Compare with…": ConfigDiffTable of the version shown against another
 * configuration or another version of this one (GET /configurations/diff). The other one is
 * the reference column, so a cell that differs is this configuration's; it starts at the
 * version this one was duplicated from.
 */
const props = defineProps<{
  detail: ConfigurationDetail;
  /** Every configuration at its latest version (the list). */
  others: ConfigurationListRow[];
}>();
const emit = defineEmits<{ close: [] }>();
const store = useConfigurationsStore();

const choices = computed(() => {
  const shown = props.detail.shown;
  const own = props.detail.versions
    .filter((v) => v.versionId !== shown.versionId)
    .map((v) => ({ value: v.versionId, label: `${v.name} v${v.version}` }));
  const rest = props.others
    .filter((r) => r.id !== props.detail.id)
    .map((r) => ({ value: r.latest.versionId, label: `${r.name} v${r.latest.version}` }));
  const all = [...own, ...rest];
  const from = props.detail.duplicatedFrom;
  if (from && !all.some((c) => c.value === from.versionId)) {
    all.unshift({ value: from.versionId, label: `${from.name} v${from.version}` });
  }
  return all;
});

const target = ref<string>('');
watch(
  choices,
  (list) => {
    if (list.some((c) => c.value === target.value)) return;
    const from = props.detail.duplicatedFrom?.versionId;
    target.value = list.find((c) => c.value === from)?.value ?? list[0]?.value ?? '';
  },
  { immediate: true },
);

const diff = ref<ConfigDiff | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const onlyDifferences = ref(false);
let asked = 0;

async function load(): Promise<void> {
  if (!target.value) {
    diff.value = null;
    return;
  }
  const mine = ++asked;
  loading.value = true;
  error.value = null;
  try {
    const found = await store.diff([target.value, props.detail.shown.versionId]);
    if (mine === asked) diff.value = found;
  } catch (err) {
    if (mine === asked) error.value = errorMessage(err);
  } finally {
    if (mine === asked) loading.value = false;
  }
}
watch([target, () => props.detail.shown.versionId], load, { immediate: true });
</script>

<template>
  <ConfigDiffTable
    v-model:only-differences="onlyDifferences"
    variant="panel"
    title="Compare with…"
    :diff="error ? null : diff"
    :loading="loading"
  >
    <template #actions>
      <select
        v-model="target"
        class="input sm w-200 font-mono"
        aria-label="Compare with"
        :disabled="choices.length === 0"
      >
        <option v-if="choices.length === 0" value="">No other configuration</option>
        <option v-for="c in choices" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
      <button type="button" class="btn sm" @click="emit('close')">Close</button>
    </template>
    <template v-if="error" #notice>
      <div class="p-16">
        <ErrorBanner
          title="Could not compare"
          :detail="error"
          retry-label="Retry"
          compact
          @retry="load"
        />
      </div>
    </template>
  </ConfigDiffTable>
</template>
