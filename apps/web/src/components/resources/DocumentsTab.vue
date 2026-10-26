<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { errorMessage } from '@/api/client';
import { documentContentUrl } from '@/api/resources';
import type { DocumentRow } from '@/api/types/resources';
import ConfirmInline from '@/components/ui/ConfirmInline.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import type { SkeletonColumn } from '@/components/ui/types';
import { formatDateTime, formatBytes, formatSha256 } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useResourcesStore } from '@/stores/resources';
import { useRevealFlashedRow } from './revealFlashedRow';
import DocumentUploadDialog from './DocumentUploadDialog.vue';

/**
 * Resources › Documents (ResourcesDocuments board): the stored files, their content hash and
 * the configurations they are attached to, with Download. A file dropped anywhere on the tab
 * opens the upload dialog at its review step; "Upload document" (the page header, or the
 * empty state) opens it at step 1. The stored document's row flashes.
 *
 * Delete (Phase 5 section 6.1; the board draws Download only, so it follows the skill panel's
 * Delete): disabled with "Attached to 1 configuration. Remove it from with-skill first." while
 * a configuration's latest version has the document; otherwise it asks in a tinted row under
 * the document's (ConfirmInline, as System's Disconnect). The API also refuses a document an
 * older configuration version keeps (409); the row then stays open with its sentence.
 */
const uploadOpen = defineModel<boolean>('uploadOpen', { default: false });

const store = useResourcesStore();
useRevealFlashedRow(() => store.flashId);
const documents = computed(() => store.documents);
const rows = computed(() => store.documentRows);
const dropped = ref<File | null>(null);
const dragging = ref(false);

const SKELETON: SkeletonColumn[] = [
  { width: [150, 120] },
  { width: 48, align: 'right' },
  { width: 90 },
  { width: 140 },
  { width: 80 },
  { width: 180 },
  { width: 70, height: 16, align: 'right' },
];

// ── Delete ────────────────────────────────────────────────────────────────
const confirmingId = ref<string | null>(null);
const deleting = ref(false);
const deleteError = ref<string | null>(null);
const confirmOpen = computed({
  get: () => confirmingId.value !== null,
  set: (open: boolean) => {
    if (!open) confirmingId.value = null;
  },
});
/** Why Delete is disabled, worded like the skill panel's tooltip. */
function deleteReason(doc: DocumentRow): string | null {
  const used = doc.attachedTo;
  if (used.length === 0) return null;
  const names = used.map((c) => c.name).join(', ');
  return `Attached to ${used.length} ${used.length === 1 ? 'configuration' : 'configurations'}. Remove it from ${names} first.`;
}
/** Opens the confirmation row; focus goes to its safe option, as ConfirmInline's own trigger does. */
async function askDelete(doc: DocumentRow): Promise<void> {
  deleteError.value = null;
  confirmingId.value = doc.id;
  await nextTick();
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[data-testid="document-delete-row"] button',
  );
  buttons[buttons.length - 1]?.focus();
}
async function confirmDelete(): Promise<void> {
  const id = confirmingId.value;
  if (id === null) return;
  deleting.value = true;
  deleteError.value = null;
  try {
    await store.deleteDocument(id);
    confirmingId.value = null;
  } catch (err) {
    deleteError.value = errorMessage(err);
  } finally {
    deleting.value = false;
  }
}
async function backOut(id: string): Promise<void> {
  deleteError.value = null;
  await nextTick();
  document.querySelector<HTMLButtonElement>(`[data-delete-document="${id}"]`)?.focus();
}

watch(uploadOpen, (isOpen) => {
  if (!isOpen) dropped.value = null;
});

function openDialog(file: File | null): void {
  dropped.value = file;
  uploadOpen.value = true;
}
function onDrop(event: DragEvent): void {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) openDialog(file);
}
function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragging.value = true;
}
function onDragLeave(event: DragEvent): void {
  const next = event.relatedTarget as Node | null;
  if (!next || !(event.currentTarget as HTMLElement).contains(next)) dragging.value = false;
}
</script>

<template>
  <div
    class="flex flex-col gap-16 rounded-6"
    :class="{ 'outline-2 outline-offset-4 outline-accent outline-dashed': dragging }"
    data-testid="documents-tab"
    @dragenter="onDragOver"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <ErrorBanner
      v-if="documents.error"
      title="Could not load documents"
      :detail="documents.error"
      retry-label="Retry"
      @retry="store.loadDocuments()"
    />

    <div
      v-if="documents.loaded && rows.length === 0 && !documents.error"
      class="flex flex-col items-center gap-8 rounded-6 border border-dashed border-border-strong bg-surface px-24 py-36 text-center"
      data-testid="empty-state"
    >
      <div class="text-15 font-semibold">No documents</div>
      <p class="max-w-440 text-text-2">
        Documents are reference files a configuration can give the agent in every run, such as a
        policy PDF. Drop files here or choose them.
      </p>
      <button type="button" class="btn primary mt-4" @click="openDialog(null)">
        Upload document
      </button>
    </div>

    <div v-else-if="documents.loaded || documents.loading" class="tbl">
      <table
        class="dt h44"
        :class="{ 'opacity-55': !!documents.error }"
        aria-label="Documents"
        :aria-busy="documents.loading && !documents.loaded ? 'true' : undefined"
      >
        <thead>
          <tr>
            <th>Filename</th>
            <th class="text-right">Size</th>
            <th>Type</th>
            <th>Hash</th>
            <th>Uploaded</th>
            <th>Attached to</th>
            <th><span class="sr-only">Download and delete</span></th>
          </tr>
        </thead>
        <tbody v-if="!documents.loaded">
          <SkeletonRows :columns="SKELETON" :rows="2" />
        </tbody>
        <tbody v-else>
          <template v-for="doc in rows" :key="doc.id">
            <tr :class="{ 'animate-flash': doc.id === store.flashId }" data-testid="document-row">
              <td class="font-mono font-semibold">{{ doc.filename }}</td>
              <td class="text-right">{{ formatBytes(doc.sizeBytes) }}</td>
              <td class="text-text-2">{{ doc.typeLabel }}</td>
              <td class="font-mono text-12 text-text-2" :title="`sha256:${doc.sha256}`">
                {{ formatSha256(doc.sha256) }}
              </td>
              <td class="text-text-2">{{ formatDateTime(doc.uploadedAt) }}</td>
              <td>
                <template v-if="doc.attachedTo.length">
                  <template v-for="(link, i) in doc.attachedTo" :key="link.configurationId"
                    >{{ i > 0 ? ', ' : ''
                    }}<RouterLink
                      class="font-mono text-12"
                      :to="{
                        name: ROUTE_NAMES.configuration,
                        params: { id: link.configurationId },
                      }"
                      >{{ link.name }}</RouterLink
                    ></template
                  >
                </template>
                <template v-else>
                  <span class="text-text-3">None</span>
                  {{ ' ' }}
                  <span class="text-12 text-text-3">not attached to any configuration</span>
                </template>
              </td>
              <td class="text-right">
                <span class="inline-flex items-center gap-6">
                  <a
                    class="btn sm"
                    :href="documentContentUrl(doc.id)"
                    :download="doc.filename"
                    :aria-label="`Download ${doc.filename}`"
                    >Download</a
                  >
                  <button
                    type="button"
                    class="btn sm"
                    :disabled="!!deleteReason(doc) || confirmingId === doc.id"
                    :title="deleteReason(doc) ?? undefined"
                    :aria-description="deleteReason(doc) ?? undefined"
                    :aria-label="`Delete ${doc.filename}`"
                    :data-delete-document="doc.id"
                    @click="askDelete(doc)"
                  >
                    Delete
                  </button>
                </span>
              </td>
            </tr>
            <tr v-if="confirmingId === doc.id" data-testid="document-delete-row">
              <td colspan="7" class="bg-fail-soft whitespace-normal">
                <ConfirmInline
                  v-model:open="confirmOpen"
                  :title="`Delete ${doc.filename}?`"
                  consequence="It leaves the library. No configuration uses it, so no run or experiment changes."
                  confirm-label="Delete document"
                  cancel-label="Keep it"
                  busy-label="Deleting…"
                  error-title="Could not delete. The document is kept."
                  layout="row"
                  button-size="mid"
                  bare
                  :busy="deleting"
                  :error="deleteError"
                  @confirm="confirmDelete"
                  @cancel="backOut(doc.id)"
                />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <div
        v-if="documents.loaded"
        class="flex items-center justify-center gap-10 border-t border-dashed border-border-strong bg-surface-2 p-14 text-text-2"
        data-testid="drop-strip"
      >
        <svg width="16" height="16" viewBox="0 0 22 22" aria-hidden="true" class="text-text-3">
          <path
            d="M11 14V4M7 8l4-4 4 4M4 15v3h14v-3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        Drop files anywhere on this tab to upload · PDF, Markdown, text or CSV up to 50 MB
      </div>
    </div>

    <DocumentUploadDialog v-model:open="uploadOpen" :initial-file="dropped" />
  </div>
</template>
