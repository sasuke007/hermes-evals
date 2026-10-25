<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type { SkillRow } from '@/api/types/resources';
import DataTable from '@/components/ui/DataTable.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import type { DataTableColumn } from '@/components/ui/types';
import { urlOptional, useUrlState } from '@/composables/useUrlState';
import { formatDateTime, shortHash } from '@/lib/format';
import { useResourcesStore } from '@/stores/resources';
import { useRevealFlashedRow } from './revealFlashedRow';
import SkillDetailDrawer from './SkillDetailDrawer.vue';
import SkillUploadDialog from './SkillUploadDialog.vue';
import UsedByLink from './UsedByLink.vue';

/**
 * Resources › Skills (ResourcesSkills board): one row per uploaded name and version. A row
 * opens the skill's detail drawer (?skill=<id>, with ?file=<path> for the file shown);
 * "Upload skill" (the page header, or the empty state) opens the two-step upload dialog, and
 * the confirmed skill's row flashes.
 */
const uploadOpen = defineModel<boolean>('uploadOpen', { default: false });

const store = useResourcesStore();
useRevealFlashedRow(() => store.flashId);
const route = useRoute();
const url = useUrlState({ skill: urlOptional(), file: urlOptional() });

const columns: DataTableColumn<SkillRow>[] = [
  { key: 'name', label: 'Name', skeleton: [110, 90] },
  { key: 'version', label: 'Version', mono: true, skeleton: 40 },
  { key: 'description', label: 'Description', skeleton: ['80%', '70%'] },
  { key: 'contentHash', label: 'Hash', skeleton: 64 },
  { key: 'uploadedAt', label: 'Uploaded', skeleton: 80 },
  { key: 'usedBy', label: 'Used by', align: 'right', skeleton: 90 },
];

const skills = computed(() => store.skills);
const firstLoadFailed = computed(() => !!skills.value.error && !skills.value.loaded);

function open(row: SkillRow): void {
  url.skill.value = row.id;
  url.file.value = null;
}
function close(): void {
  url.skill.value = null;
  url.file.value = null;
}
const detailLink = (row: SkillRow) => ({
  query: { ...route.query, skill: row.id, file: undefined },
});
</script>

<template>
  <ErrorBanner
    v-if="firstLoadFailed"
    title="Could not load skills"
    :detail="skills.error"
    retry-label="Retry"
    @retry="store.loadSkills()"
  />
  <DataTable
    v-else
    :columns="columns"
    :rows="store.skillRows"
    :loading="skills.loading && !skills.loaded"
    :error="skills.error"
    error-title="Could not load skills"
    label="Skills"
    table-class="h44"
    clickable
    :row-class="(row) => (row.id === store.flashId ? 'animate-flash' : undefined)"
    :skeleton-rows="3"
    @row-click="open"
    @retry="store.loadSkills()"
  >
    <template #cell-name="{ row }">
      <RouterLink
        :to="detailLink(row)"
        class="font-mono font-semibold text-text"
        :aria-label="`${row.name} ${row.version}: open the skill`"
        >{{ row.name }}</RouterLink
      >
    </template>
    <template #cell-description="{ row }">
      <span class="block max-w-560 py-6 whitespace-normal text-text-2">{{ row.description }}</span>
    </template>
    <template #cell-contentHash="{ row }">
      <span class="font-mono text-12 text-text-2" :title="`sha256:${row.contentHash}`">{{
        shortHash(row.contentHash, 8)
      }}</span>
    </template>
    <template #cell-uploadedAt="{ row }">
      <span class="text-text-2">{{ formatDateTime(row.uploadedAt) }}</span>
    </template>
    <template #cell-usedBy="{ row }"><UsedByLink :links="row.usedBy" /></template>
    <template #empty>
      <div
        class="flex flex-col items-center gap-8 px-24 py-40 text-center"
        data-testid="empty-state"
      >
        <div class="text-15 font-semibold">No skills uploaded</div>
        <p class="max-w-480 text-text-2">
          A skill is a folder with a <code>SKILL.md</code> and any files it references, uploaded as
          a zip. Configurations can include skills to test whether they help.
        </p>
        <button type="button" class="btn primary mt-4" @click="uploadOpen = true">
          Upload skill
        </button>
      </div>
    </template>
  </DataTable>

  <SkillUploadDialog v-model:open="uploadOpen" />
  <SkillDetailDrawer
    v-if="url.skill.value"
    :skill-id="url.skill.value"
    :file="url.file.value"
    @update:file="url.file.value = $event"
    @close="close"
  />
</template>
