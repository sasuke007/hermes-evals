<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import ConfigDiffTable from '@/components/configurations/ConfigDiffTable.vue';
import ConfigListTable from '@/components/configurations/ConfigListTable.vue';
import PageContainer from '@/components/layout/PageContainer.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import { errorMessage } from '@/api/client';
import type { ConfigDiff } from '@/api/types/configurations';
import { ROUTE_NAMES } from '@/router';
import { useConfigurationsStore } from '@/stores/configurations';
import { plural } from '@/lib/format';

/**
 * The configuration list (ConfigList board; UI_FLOWS 10.2): every configuration at its
 * latest version. Picking two or three rows enables Compare, which opens ConfigDiffTable
 * under the table (GET /configurations/diff, the first picked row is the reference); the
 * comparison follows the picks while it is open, and "Only show differences" hides equal
 * rows. A row opens the detail; New configuration opens the form. Loading, empty and load
 * error as LibraryStates draws them. With a long list the comparison opens far below the
 * button, so Compare scrolls it into view.
 */
const store = useConfigurationsStore();
void store.loadList();

/** The API answers two or three versions. */
const MAX_COMPARED = 3;

const selected = ref<string[]>([]);
const comparing = ref(false);
const onlyDifferences = ref(false);
const diff = ref<ConfigDiff | null>(null);
const diffLoading = ref(false);
const diffError = ref<string | null>(null);

const loading = computed(() => store.listState.loading && !store.listState.loaded);
const rows = computed(() => store.list);
/** Picked rows in list order, so the first configuration is the reference column. */
const picked = computed(() => rows.value.filter((r) => selected.value.includes(r.id)));

const compareReason = computed(() => {
  if (picked.value.length < 2) return 'Select two or more configurations';
  if (picked.value.length > MAX_COMPARED) return 'Compare at most three configurations';
  return null;
});
const showCompare = computed(() => comparing.value && compareReason.value === null);

const diffPanel = ref<{ $el: Element | null } | null>(null);

/** Compare: open the comparison and bring it into view (it sits under the whole list). */
async function openCompare(): Promise<void> {
  comparing.value = true;
  await nextTick();
  const el = diffPanel.value?.$el;
  if (el instanceof Element) el.scrollIntoView?.({ block: 'nearest' });
}

let asked = 0;
async function loadDiff(): Promise<void> {
  if (!showCompare.value) return;
  const mine = ++asked;
  diffLoading.value = true;
  diffError.value = null;
  try {
    const found = await store.diff(picked.value.map((r) => r.latest.versionId));
    if (mine === asked) diff.value = found;
  } catch (err) {
    if (mine === asked) diffError.value = errorMessage(err);
  } finally {
    if (mine === asked) diffLoading.value = false;
  }
}
watch(
  () => (showCompare.value ? picked.value.map((r) => r.latest.versionId).join(',') : ''),
  () => void loadDiff(),
);

// Rows that are gone after a reload leave the selection.
watch(rows, (list) => {
  selected.value = selected.value.filter((id) => list.some((r) => r.id === id));
});
</script>

<template>
  <PageContainer variant="list">
    <PageHeader
      title="Configurations"
      :count="store.listState.loaded ? plural(rows.length, 'configuration') : null"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          :disabled="compareReason !== null"
          :title="compareReason ?? 'Open the side-by-side comparison'"
          :aria-description="compareReason ?? undefined"
          :aria-expanded="showCompare ? 'true' : 'false'"
          data-testid="compare"
          @click="openCompare"
        >
          Compare ({{ picked.length }})
        </button>
        <RouterLink class="btn primary" :to="{ name: ROUTE_NAMES.configurationNew }"
          >New configuration</RouterLink
        >
      </template>
    </PageHeader>

    <ErrorBanner
      v-if="store.listState.error && !store.listState.loaded"
      title="Could not load configurations"
      :detail="store.listState.error"
      retry-label="Retry"
      @retry="store.loadList()"
    />
    <template v-else>
      <ErrorBanner
        v-if="store.listState.error"
        title="Could not refresh configurations"
        :detail="store.listState.error"
        retry-label="Retry"
        @retry="store.loadList()"
      />
      <ConfigListTable v-model:selected="selected" :rows="rows" :loading="loading" />

      <ConfigDiffTable
        v-if="showCompare"
        ref="diffPanel"
        v-model:only-differences="onlyDifferences"
        variant="panel"
        title="Compare configurations"
        :diff="diffError ? null : diff"
        :loading="diffLoading && !diff"
      >
        <template #actions>
          <button type="button" class="btn sm" @click="comparing = false">Close</button>
        </template>
        <template v-if="diffError" #notice>
          <div class="p-16">
            <ErrorBanner
              title="Could not compare"
              :detail="diffError"
              retry-label="Retry"
              compact
              @retry="loadDiff"
            />
          </div>
        </template>
      </ConfigDiffTable>
    </template>
  </PageContainer>
</template>
