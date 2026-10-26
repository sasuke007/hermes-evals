<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import { onClickOutside } from '@vueuse/core';
import type { DraftTaskDetail } from '@/api/types/authoring';
import BaseBreadcrumb from '@/components/ui/BaseBreadcrumb.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { hhmm } from '@/components/authoring/draft-bar/draftText';
import type { TaskSaveStatus } from '@/stores/draftTask';

/**
 * The task editor's head (SA.4): the breadcrumb, the key with its change chip and the save
 * line ("draft · saved 16:31"), Back to suite, and the ⋯ menu: Duplicate, Revert to v6 (for
 * a task the base holds; it asks first, in place), Remove from suite. The save line reads
 * "draft · saving…" while a write waits or runs and "draft · not saved" after a failure
 * (copy no board draws).
 */
const props = defineProps<{
  detail: DraftTaskDetail;
  shownKey: string;
  status: TaskSaveStatus;
  breadcrumbs: BreadcrumbItem[];
  backTo: RouteLocationRaw;
  busy: boolean;
}>();
const emit = defineEmits<{ back: []; duplicate: []; revert: []; remove: [] }>();

const menu = ref(false);
const confirmRevert = ref(false);
const root = ref<HTMLElement | null>(null);
const keepButton = ref<HTMLButtonElement | null>(null);
onClickOutside(root, () => (menu.value = false));

const chip = computed(() => {
  const d = props.detail;
  if (d.state === 'restored' && d.restoredFrom)
    return `restored from v${d.restoredFrom.taskVersion}`;
  if (d.base && d.base.key !== d.key) return `renamed from ${d.base.key}`;
  return d.state === 'unchanged' ? null : d.state;
});
const line = computed(() => {
  if (props.status === 'saving') return 'draft · saving…';
  if (props.status === 'failed') return 'draft · not saved';
  if (props.detail.state === 'unchanged') return 'in the draft · no changes to this task yet';
  return `draft · saved ${hhmm(props.detail.updatedAt)}`;
});
const baseVersion = computed(() => props.detail.draft.baseVersion);

async function askRevert(): Promise<void> {
  menu.value = false;
  confirmRevert.value = true;
  await nextTick();
  keepButton.value?.focus();
}

function pick(action: 'duplicate' | 'remove'): void {
  menu.value = false;
  if (action === 'duplicate') emit('duplicate');
  else emit('remove');
}

function revert(): void {
  confirmRevert.value = false;
  emit('revert');
}
</script>

<template>
  <div class="flex flex-wrap items-start justify-between gap-12">
    <div class="flex flex-col gap-6">
      <BaseBreadcrumb :items="breadcrumbs" />
      <div class="flex flex-wrap items-center gap-10">
        <h1 class="m-0 font-mono text-20 font-semibold" data-testid="task-key">{{ shownKey }}</h1>
        <span v-if="chip" class="tag" data-testid="task-change">{{ chip }}</span>
        <span class="text-12 text-text-3" role="status" data-testid="save-line">{{ line }}</span>
      </div>
    </div>
    <div ref="root" class="relative flex gap-8">
      <RouterLink class="btn" :to="backTo" @click.capture="emit('back')">Back to suite</RouterLink>
      <button
        type="button"
        class="btn w-32 px-0"
        aria-label="More actions"
        title="More actions"
        aria-haspopup="menu"
        :aria-expanded="menu"
        :disabled="busy"
        @click="menu = !menu"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      <div
        v-if="menu"
        role="menu"
        class="absolute top-36 right-0 z-5 flex w-240 flex-col rounded-6 border border-border bg-surface p-4 shadow-float"
        @keydown.esc="menu = false"
      >
        <button
          type="button"
          role="menuitem"
          class="flex flex-col items-start rounded-4 px-10 py-6 text-left hover:bg-surface-2"
          @click="pick('duplicate')"
        >
          Duplicate
        </button>
        <button
          v-if="detail.base && baseVersion"
          type="button"
          role="menuitem"
          class="flex flex-col items-start gap-2 rounded-4 px-10 py-6 text-left hover:bg-surface-2"
          @click="askRevert"
        >
          <span>Revert to v{{ baseVersion }}</span
          ><span class="text-12 text-text-3">Asks first, in place</span>
        </button>
        <div v-else class="flex flex-col items-start gap-2 px-10 py-6" aria-disabled="true">
          <span class="text-text-3">Revert to v{{ baseVersion ?? 1 }}</span>
          <span class="text-12 text-text-3"
            ><code>{{ detail.key }}</code> is new in this draft</span
          >
        </div>
        <button
          type="button"
          role="menuitem"
          class="rounded-4 px-10 py-6 text-left text-fail-text hover:bg-surface-2"
          @click="pick('remove')"
        >
          Remove from suite
        </button>
      </div>
    </div>
    <div
      v-if="confirmRevert"
      role="alertdialog"
      aria-label="Revert"
      class="flex basis-full flex-wrap items-center gap-x-14 gap-y-10 rounded-6 border border-fail bg-fail-soft px-12 py-10"
      @keydown.esc="confirmRevert = false"
    >
      <span class="min-w-260 flex-1"
        ><b class="text-fail-text"
          >Revert <code>{{ detail.key }}</code> to v{{ baseVersion }}?</b
        >{{ ' '
        }}<span class="text-text-2"
          >The draft's changes to this task are dropped. Nothing on disk changes.</span
        ></span
      >
      <button type="button" class="btn danger" @click="revert">Revert</button>
      <button ref="keepButton" type="button" class="btn" @click="confirmRevert = false">
        Keep editing
      </button>
    </div>
  </div>
</template>
