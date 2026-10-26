<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import NoteIcon from '@/components/authoring/editors/NoteIcon.vue';
import { formatBytes, plural } from '@/lib/format';
import type { UploadItem } from '@/stores/draftTaskTools';

/**
 * Leaving the editor while an upload runs (SA.13): asks in place, under the header, "1 upload
 * is still running. Leave anyway?" Leaving cancels the uploads; everything else in the
 * draft is kept. Focus goes to Stay.
 */
const props = defineProps<{ uploads: UploadItem[] }>();
const emit = defineEmits<{ leave: []; stay: [] }>();
const stay = ref<HTMLButtonElement | null>(null);
onMounted(async () => {
  await nextTick();
  stay.value?.focus();
});

const title = computed(() =>
  props.uploads.length === 1
    ? '1 upload is still running. Leave anyway?'
    : `${plural(props.uploads.length, 'upload')} are still running. Leave anyway?`,
);
const names = computed(() => props.uploads.map((u) => u.name));
const percent = (u: UploadItem) => (u.total ? Math.round((u.loaded / u.total) * 100) : 0);
</script>

<template>
  <div class="flex flex-col gap-12">
    <div
      role="alertdialog"
      aria-label="Leave the editor"
      class="flex flex-wrap items-center gap-x-14 gap-y-10 rounded-6 border border-ung bg-ung-soft px-12 py-10"
      data-testid="leave-during-upload"
      @keydown.esc="emit('stay')"
    >
      <NoteIcon kind="warning" />
      <span class="min-w-280 flex-1"
        ><b class="text-ung-text">{{ title }}</b
        >{{ ' '
        }}<span class="text-text-2">
          Leaving cancels {{ uploads.length === 1 ? 'it' : 'them' }}:
          <template v-for="(n, i) in names" :key="n"
            ><code>{{ n }}</code
            >{{ i < names.length - 1 ? ', ' : '' }}</template
          >
          won't be added. Everything else in the draft is kept.</span
        ></span
      >
      <button type="button" class="btn danger" @click="emit('leave')">Leave anyway</button>
      <button ref="stay" type="button" class="btn" @click="emit('stay')">Stay</button>
    </div>
    <div
      v-for="u in uploads"
      :key="u.id"
      class="grid grid-cols-[minmax(0,1fr)_120px_80px] items-center gap-12 rounded-4 border border-border px-12 py-8"
    >
      <span class="flex flex-col gap-6"
        ><span class="font-mono text-12">{{ u.target }}</span
        ><span class="block h-3 overflow-hidden rounded-2 bg-surface-3"
          ><span class="block h-3 bg-run" :style="{ width: `${percent(u)}%` }" /></span
      ></span>
      <span class="text-12 text-text-3"
        >{{ formatBytes(u.loaded) }} of {{ formatBytes(u.total) }}</span
      >
      <span class="text-right text-12 text-text-3">{{ percent(u) }}%</span>
    </div>
  </div>
</template>
