<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { errorMessage } from '@/api/client';
import { skillZipUrl } from '@/api/resources';
import BaseDrawer from '@/components/ui/BaseDrawer.vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import ConfirmInline from '@/components/ui/ConfirmInline.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import { formatDateTime, shortHash, formatBytes, plural } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useResourcesStore } from '@/stores/resources';
import MarkdownView from './MarkdownView.vue';
import SkillFileView from './SkillFileView.vue';

/**
 * A skill's detail, opened from its row on the Skills tab: a right-hand panel 640px wide
 * (ResourcesDocuments board, "Skill detail"). The header names the version and its hash,
 * when it was uploaded and which configurations use it, with Download zip. Below, the file
 * tree and the file it selects: SKILL.md (front matter as written, then its Markdown) by
 * default, any other file as SkillFileView draws it. Route-backed by the page (?skill=,
 * ?file=); Esc, × or the scrim close it.
 *
 * Delete (Phase 5 section 6.1) sits beside Download zip, as the board draws it: disabled with
 * "Used by 1 configuration. Remove it from with-skill first." while a configuration's latest
 * version uses the skill. Otherwise it asks in place (ConfirmInline under the header) and, once
 * deleted, closes the panel. The API also refuses a skill an older configuration version keeps
 * (409); the confirmation then stays open with its sentence.
 */
const props = defineProps<{ skillId: string; file: string | null }>();
const emit = defineEmits<{ 'update:file': [path: string | null]; close: [] }>();

const store = useResourcesStore();
const SKILL_MD = 'SKILL.md';

watch(
  () => props.skillId,
  (id) => void store.loadSkillDetail(id),
  { immediate: true },
);

const entry = computed(() => store.skillDetails[props.skillId] ?? null);
const detail = computed(() => entry.value?.value ?? null);
const current = computed(() => props.file ?? SKILL_MD);
const isSkillMd = computed(() => current.value === SKILL_MD);

watch(
  [() => props.skillId, current, detail],
  ([id, path, d]) => {
    if (d && path !== SKILL_MD) void store.loadSkillFile(id, path);
  },
  { immediate: true },
);
const fileEntry = computed(() =>
  isSkillMd.value ? null : store.skillFile(props.skillId, current.value),
);

// ── Delete ────────────────────────────────────────────────────────────────
const confirming = ref(false);
const deleting = ref(false);
const deleteError = ref<string | null>(null);
const deleteButton = ref<HTMLButtonElement | null>(null);
/** Why Delete is disabled: the board's tooltip, for the configurations "Used by" names. */
const deleteReason = computed(() => {
  const used = detail.value?.usedBy ?? [];
  if (used.length === 0) return null;
  const names = used.map((c) => c.name).join(', ');
  return `Used by ${used.length} ${used.length === 1 ? 'configuration' : 'configurations'}. Remove it from ${names} first.`;
});

async function confirmDelete(): Promise<void> {
  deleting.value = true;
  deleteError.value = null;
  try {
    await store.deleteSkill(props.skillId);
    emit('close');
  } catch (err) {
    deleteError.value = errorMessage(err);
  } finally {
    deleting.value = false;
  }
}
async function backOut(): Promise<void> {
  deleteError.value = null;
  await nextTick();
  deleteButton.value?.focus();
}
watch(
  () => props.skillId,
  () => {
    confirming.value = false;
    deleteError.value = null;
  },
);

const depth = (path: string): number => path.split('/').length - 1;
const titleId = `skill-detail-${props.skillId}`;

function pick(path: string): void {
  emit('update:file', path === SKILL_MD ? null : path);
}
</script>

<template>
  <BaseDrawer
    :title-id="titleId"
    initial-focus="[data-close]"
    :width="640"
    body-class="grid min-h-420 flex-1 grid-cols-[240px_minmax(0,1fr)] bg-surface max-sm:grid-cols-1"
    data-testid="skill-drawer"
    @close="emit('close')"
  >
    <template #header>
      <div class="flex flex-wrap items-start justify-between gap-12">
        <div class="flex min-w-0 flex-col gap-4">
          <div class="flex flex-wrap items-center gap-10">
            <h2 :id="titleId" class="font-mono text-17 font-semibold">
              {{ detail?.name ?? 'Skill' }}
            </h2>
            <template v-if="detail">
              <BaseTag>{{ detail.version }}</BaseTag>
              <BaseTag :title="`sha256:${detail.contentHash}`"
                >sha256:{{ shortHash(detail.contentHash, 8) }}</BaseTag
              >
            </template>
          </div>
          <template v-if="detail">
            <p class="text-text-2">{{ detail.description }}</p>
            <p class="text-12 text-text-3" data-testid="skill-meta">
              Uploaded {{ formatDateTime(detail.uploadedAt) }} ·
              {{ plural(detail.fileCount, 'file') }} ·
              <template v-if="detail.usedBy.length"
                >used by
                <template v-for="(link, i) in detail.usedBy" :key="link.configurationId"
                  >{{ i > 0 ? ', ' : ''
                  }}<RouterLink
                    class="font-mono"
                    :to="{ name: ROUTE_NAMES.configuration, params: { id: link.configurationId } }"
                    >{{ link.name }}</RouterLink
                  ></template
                ></template
              ><template v-else>not used by any configuration</template>
            </p>
          </template>
        </div>
        <div class="flex items-center gap-8">
          <a
            v-if="detail"
            class="btn sm"
            :href="skillZipUrl(detail.id)"
            :download="`${detail.name}-${detail.version}.zip`"
            >Download zip</a
          >
          <button
            v-if="detail"
            ref="deleteButton"
            type="button"
            class="btn sm"
            :disabled="!!deleteReason || confirming"
            :title="deleteReason ?? undefined"
            :aria-description="deleteReason ?? undefined"
            data-testid="delete-skill"
            @click="confirming = true"
          >
            Delete
          </button>
          <button
            type="button"
            class="btn ghost h-28 px-6"
            aria-label="Close"
            title="Close (Esc)"
            data-close
            @click="emit('close')"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3.5 3.5l7 7M10.5 3.5l-7 7"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <ConfirmInline
        v-if="detail"
        v-model:open="confirming"
        :class="{ 'mt-12': confirming }"
        layout="row"
        button-size="mid"
        :title="`Delete ${detail.name} ${detail.version}?`"
        consequence="It leaves the library. No configuration uses it, so no run or experiment changes."
        confirm-label="Delete skill"
        cancel-label="Keep it"
        busy-label="Deleting…"
        error-title="Could not delete. The skill is kept."
        :busy="deleting"
        :error="deleteError"
        @confirm="confirmDelete"
        @cancel="backOut"
      />
    </template>

    <div v-if="entry?.error" class="col-span-full p-16">
      <ErrorBanner
        title="Could not load the skill"
        :detail="entry.error"
        retry-label="Retry"
        @retry="store.loadSkillDetail(skillId)"
      />
    </div>
    <div v-else-if="!detail" class="col-span-full p-16" aria-busy="true">
      <SkeletonRows layout="lines" :columns="[{ width: ['40%', '95%', '80%', '60%'] }]" :rows="4" />
    </div>
    <template v-else>
      <nav
        class="flex flex-col gap-2 border-r border-border bg-surface-2 p-8 max-sm:border-r-0 max-sm:border-b"
        aria-label="Files"
      >
        <button
          v-for="f in detail.files"
          :key="f.path"
          type="button"
          class="flex h-28 w-full items-center gap-6 rounded-4 border-0 px-10 text-left font-mono text-12 aria-[current=true]:bg-accent-soft aria-[current=true]:font-semibold aria-[current=true]:text-text"
          :class="[current === f.path ? '' : 'bg-transparent text-text-2 hover:bg-surface-3']"
          :style="depth(f.path) ? { paddingLeft: `${10 + 12 * depth(f.path)}px` } : undefined"
          :aria-current="current === f.path ? 'true' : 'false'"
          @click="pick(f.path)"
        >
          <span class="min-w-0 truncate" :title="f.path">{{ f.path }}</span>
          <span class="ml-auto flex-none text-12 font-normal text-text-3">{{
            formatBytes(f.sizeBytes)
          }}</span>
        </button>
      </nav>
      <div class="flex min-w-0 flex-col gap-12 px-24 py-20" data-testid="skill-content">
        <template v-if="isSkillMd">
          <CodeBlock :code="detail.skillMd.frontMatter" size="sm" label="SKILL.md front matter" />
          <MarkdownView :source="detail.skillMd.body" />
        </template>
        <ErrorBanner
          v-else-if="fileEntry?.error"
          :title="`Could not load ${current}`"
          :detail="fileEntry.error"
          compact
        />
        <SkillFileView v-else-if="fileEntry?.value" :file="fileEntry.value" />
        <div v-else aria-busy="true">
          <SkeletonRows layout="lines" :columns="[{ width: ['30%', '90%', '75%'] }]" :rows="3" />
        </div>
      </div>
    </template>
  </BaseDrawer>
</template>
