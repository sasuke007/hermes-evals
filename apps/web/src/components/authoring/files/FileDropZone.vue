<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { AUTHORING_LIMITS } from '@hermes-evals/shared';
import type { RejectedFile, UploadItem } from '@/stores/draftTaskTools';
import { formatBytes } from '@/lib/format';
import EditorNote from '../editors/EditorNote.vue';
import { droppedFiles, type DroppedFile } from './dropFiles';

/**
 * Where files are added to a task (Components 5, FileDropZone): a 1px dashed box, 88px high,
 * "Drop files or a folder, or browse", up to 25 MB per file; accent while something is
 * dragged over it ("Drop to add to workspace files"). Each upload shows under it with a thin
 * bar and Cancel; a file over the limit is refused before it is sent, and says so. A .zip is
 * added as one file: unpacking it ("Unpack into workspace files") is not offered.
 */
const props = withDefaults(
  defineProps<{
    /** What the files are added to: "workspace files", "the expected workspace", "home files". */
    target: string;
    uploads?: UploadItem[];
    rejected?: RejectedFile[];
    disabled?: boolean;
    /** Shown above the box when files go into a folder ("Adding to docs/"). */
    folder?: string | null;
  }>(),
  { uploads: () => [], rejected: () => [], disabled: false, folder: null },
);
const emit = defineEmits<{
  files: [files: DroppedFile[]];
  cancel: [id: number];
  dismiss: [name: string];
  clearFolder: [];
}>();

const over = ref(false);
const input = ref<HTMLInputElement | null>(null);
const ids = useId();
const limit = formatBytes(AUTHORING_LIMITS.suiteMaxFileBytes);

const lead = computed(() =>
  over.value ? `Drop to add to ${props.target}` : 'Drop files or a folder, or',
);

async function onDrop(event: DragEvent): Promise<void> {
  over.value = false;
  if (props.disabled) return;
  const files = await droppedFiles(event.dataTransfer);
  if (files.length) emit('files', files);
}

function onPick(event: Event): void {
  const el = event.target as HTMLInputElement;
  const files = [...(el.files ?? [])].map((file) => ({ file, path: file.name }));
  el.value = '';
  if (files.length) emit('files', files);
}

/** "9.1 of 22.6 KB": the part sent in the unit of the whole. */
function progressText(loaded: number, total: number): string {
  const whole = formatBytes(total);
  const unit = whole.split(' ')[1] ?? 'B';
  const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit] ?? 1;
  const part = loaded / scale;
  return `${scale === 1 ? part : part.toFixed(1).replace(/\.0$/, '')} of ${whole}`;
}

const OVER_LIMIT = 'The limit is 25 MB per file.';

function browse(): void {
  if (!props.disabled) input.value?.click();
}
</script>

<template>
  <div class="flex w-full flex-col gap-8" data-testid="file-drop-zone">
    <div v-if="folder" class="flex items-center gap-8 text-12 text-text-2">
      <span
        >Adding to <code>{{ folder }}</code></span
      >
      <button type="button" class="linkbtn text-12" @click="emit('clearFolder')">
        Add to the top level
      </button>
    </div>
    <div
      role="button"
      tabindex="0"
      :aria-label="`Add files to ${target}`"
      :aria-disabled="disabled ? 'true' : undefined"
      :aria-describedby="`${ids}-cap`"
      class="flex h-88 flex-col items-center justify-center gap-2 rounded-4 text-center"
      :class="
        over
          ? 'border border-accent bg-accent-soft text-text'
          : 'border border-dashed border-border-strong bg-surface text-text-2'
      "
      :data-over="over || undefined"
      @click="browse"
      @keydown.enter.prevent="browse"
      @keydown.space.prevent="browse"
      @dragenter.prevent="over = !disabled"
      @dragover.prevent="over = !disabled"
      @dragleave.prevent="over = false"
      @drop.prevent="onDrop"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class="text-text-3"
      >
        <path d="M12 3v12" />
        <path d="m17 8-5-5-5 5" />
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      </svg>
      <span
        >{{ lead }}
        <a v-if="!over" href="#" class="font-semibold" @click.prevent.stop="browse">browse</a></span
      >
      <span :id="`${ids}-cap`" class="text-12 text-text-3">Up to {{ limit }} per file</span>
      <input
        ref="input"
        type="file"
        multiple
        class="hidden"
        tabindex="-1"
        aria-hidden="true"
        @change="onPick"
      />
    </div>
    <div
      v-for="item in uploads"
      :key="item.id"
      class="grid grid-cols-[minmax(0,1fr)_220px_auto_auto] items-center gap-12 rounded-4 border border-border bg-surface px-12 py-8"
      data-testid="upload-row"
    >
      <span class="truncate font-mono text-12">{{ item.target }}</span>
      <span
        class="block h-4 overflow-hidden rounded-2 bg-surface-3"
        role="progressbar"
        :aria-valuenow="item.loaded"
        :aria-valuemax="item.total"
        :aria-label="`Uploading ${item.name}`"
      >
        <span
          class="block h-full bg-run"
          :style="{ width: `${item.total ? Math.round((item.loaded / item.total) * 100) : 0}%` }"
        />
      </span>
      <span class="text-right text-12 text-text-3">{{
        progressText(item.loaded, item.total)
      }}</span>
      <button type="button" class="btn ghost h-24 px-6 text-12" @click="emit('cancel', item.id)">
        Cancel
      </button>
    </div>
    <EditorNote
      v-for="file in rejected"
      :key="file.name"
      tone="problem"
      alert
      data-testid="upload-rejected"
    >
      <template #lead
        ><code>{{ file.name }}</code
        ><template v-if="file.reason === OVER_LIMIT">
          is {{ formatBytes(file.sizeBytes) }}. {{ file.reason }}</template
        ><template v-else> was not added.</template></template
      >
      <span class="text-text-2">{{
        file.reason === OVER_LIMIT ? 'The file was not added.' : file.reason
      }}</span>
      <template #actions>
        <button
          type="button"
          class="btn ghost h-24 px-6 text-12"
          :aria-label="`Dismiss ${file.name}`"
          @click="emit('dismiss', file.name)"
        >
          ×
        </button>
      </template>
    </EditorNote>
  </div>
</template>
