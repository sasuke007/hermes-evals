<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { errorMessage } from '@/api/client';
import { DOCUMENT_MAX_BYTES } from '@/api/resources';
import BaseDialog from '@/components/ui/BaseDialog.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { useResourcesStore } from '@/stores/resources';
import { formatBytes, formatSha256 } from '@/lib/format';
import UploadDropZone from './UploadDropZone.vue';
import UploadFileRow from './UploadFileRow.vue';
import UploadProblem from './UploadProblem.vue';

/**
 * Upload document, the same two steps as a skill (Library states › Upload document): choose
 * or drop a file, review it, and store it on Confirm. The API has no dry run for documents,
 * so the review is the browser's own: the 50 MB cap, no zip archives, and the content hash
 * of the bytes it will send. The API sets the type label ("PDF · 6 pages") when it stores
 * the file. A new document is attached to no configuration.
 */
const props = withDefaults(defineProps<{ initialFile?: File | null }>(), { initialFile: null });
const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ uploaded: [id: string] }>();

const store = useResourcesStore();

const file = ref<File | null>(null);
const hash = ref<string | null>(null);
const confirming = ref(false);
const confirmError = ref<string | null>(null);

/** The type word the API gives these extensions (documents/type-label.ts). */
const KINDS: Record<string, string> = {
  pdf: 'PDF',
  md: 'Markdown',
  markdown: 'Markdown',
  txt: 'Text',
  csv: 'CSV',
  tsv: 'TSV',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
};
const extension = (name: string): string => /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
function kindOf(name: string): string {
  const ext = extension(name);
  return KINDS[ext] ?? (/^[a-z0-9]{1,8}$/.test(ext) ? ext.toUpperCase() : 'File');
}
const isZip = (f: File): boolean =>
  extension(f.name) === 'zip' ||
  f.type === 'application/zip' ||
  f.type === 'application/x-zip-compressed';

type Problem = { title: string; detail: string };
const problem = computed<Problem | null>(() => {
  const f = file.value;
  if (!f) return null;
  if (f.size > DOCUMENT_MAX_BYTES) {
    return {
      title: `${formatBytes(f.size)} is over the 50 MB limit.`,
      detail: 'Split the file, or keep only the columns the agent needs.',
    };
  }
  if (isZip(f)) {
    return {
      title: 'ZIP archives are not accepted as documents.',
      detail: 'Upload PDF, Markdown, text or CSV. Skills are uploaded as .zip on the Skills tab.',
    };
  }
  return null;
});

/** sha256 of the file, where the browser offers SubtleCrypto (a secure context). */
async function digest(f: File): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const bytes = new Uint8Array(await subtle.digest('SHA-256', await f.arrayBuffer()));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

let attempt = 0;
async function choose(picked: File | null): Promise<void> {
  const mine = ++attempt;
  file.value = picked;
  hash.value = null;
  confirmError.value = null;
  if (!picked || problem.value) return;
  const sha = await digest(picked);
  if (mine === attempt) hash.value = sha;
}

watch(open, (isOpen) => {
  if (isOpen) void choose(props.initialFile);
});
watch(
  () => props.initialFile,
  (next) => {
    if (open.value && next) void choose(next);
  },
);

async function confirm(): Promise<void> {
  const f = file.value;
  if (!f || problem.value || confirming.value) return;
  confirming.value = true;
  confirmError.value = null;
  try {
    const row = await store.uploadDocument(f);
    open.value = false;
    emit('uploaded', row.id);
  } catch (err) {
    confirmError.value = errorMessage(err);
  } finally {
    confirming.value = false;
  }
}

const stepLabel = computed(() =>
  file.value ? 'Step 2 of 2 · review' : 'Step 1 of 2 · choose file',
);
const details = computed(() => {
  const f = file.value;
  if (!f) return [];
  return [
    { label: 'filename', value: f.name, mono: true },
    { label: 'type', value: kindOf(f.name), mono: false },
    ...(hash.value ? [{ label: 'content hash', value: formatSha256(hash.value), mono: true }] : []),
  ];
});
</script>

<template>
  <BaseDialog
    v-model:open="open"
    title="Upload document"
    :width="600"
    body-class="flex flex-col gap-10 p-16"
    data-testid="document-upload-dialog"
  >
    <template #header-extra>
      <span class="text-12 text-text-3" data-testid="step-label">{{ stepLabel }}</span>
    </template>

    <UploadDropZone
      v-if="!file"
      caption="PDF, Markdown, text or CSV · up to 50 MB"
      padding="sm"
      @file="choose"
      ><b>Drop a file here, or <span class="text-accent">choose one</span></b></UploadDropZone
    >

    <template v-else>
      <UploadFileRow
        :name="file.name"
        :size-bytes="file.size"
        :oversize="file.size > DOCUMENT_MAX_BYTES"
      />
      <template v-if="problem">
        <div class="font-semibold text-fail-text" data-testid="upload-lead">
          1 problem. Nothing was stored.
        </div>
        <UploadProblem boxed :title="problem.title" :detail="problem.detail" />
      </template>
      <template v-else>
        <div class="font-semibold text-pass-text" data-testid="upload-lead">
          Valid document · nothing stored yet
        </div>
        <dl
          class="grid grid-cols-[130px_minmax(0,1fr)] gap-x-8 gap-y-4 rounded-4 border border-border px-12 py-8 text-12"
          data-testid="document-review"
        >
          <template v-for="row in details" :key="row.label">
            <dt class="text-text-2">{{ row.label }}</dt>
            <dd class="min-w-0 break-words" :class="{ 'font-mono': row.mono }">{{ row.value }}</dd>
          </template>
          <dt class="text-text-2">attached to</dt>
          <dd class="text-text-3">none yet · add it from a configuration's Documents field</dd>
        </dl>
      </template>
      <ErrorBanner
        v-if="confirmError"
        title="The document was not stored"
        :detail="confirmError"
        compact
      />
    </template>

    <template #footer>
      <button v-if="problem" type="button" class="btn" @click="choose(null)">
        Choose another file
      </button>
      <button v-else type="button" class="btn" @click="open = false">Cancel</button>
      <button
        type="button"
        class="btn primary"
        :disabled="!file || !!problem || confirming"
        data-testid="confirm-upload"
        @click="confirm"
      >
        {{ confirming ? 'Storing…' : 'Confirm upload' }}
      </button>
    </template>
  </BaseDialog>
</template>
