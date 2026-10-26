<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { DraftFileView } from '@/api/types/authoring';
import type { TablePreview } from '@/api/types/suites';
import TablePreviewTable from '@/components/suites/TablePreviewTable.vue';
import { formatBytes, plural, shortHash } from '@/lib/format';
import CodeText from '../editors/CodeText.vue';
import EditorNote from '../editors/EditorNote.vue';
import { collidesWithDocs, insideFolder, isPreviewable, treeRows } from './fileRows';
import PathText from './PathText.vue';

/**
 * The files of one part of a task (Components 5, TaskFileTree, workspace mode; SA.4 to
 * SA.6): workspace files as the agent sees them (`/workspace/invoices.csv`), the expected
 * workspace, or home seeds. Each row has its type, size, short hash and actions; a CSV can
 * be previewed in place; Rename edits the name in place and Delete asks first. A file that
 * holds a reference value, or that sits under docs/, carries its note. "New folder" names a
 * folder the next files go into; copying files from another task has no endpoint and is not
 * offered.
 */
const props = withDefaults(
  defineProps<{
    mode: 'workspace' | 'expected' | 'home';
    files: DraftFileView[];
    /** The kind's folder in the task: `fixtures`, `expected`, `home`. */
    folder: string;
    /** Notes on files, by path (the leak warning). */
    notes?: Record<string, string>;
    previews?: Record<string, TablePreview | null>;
    readonly?: boolean;
  }>(),
  { notes: () => ({}), previews: () => ({}), readonly: false },
);
const emit = defineEmits<{
  preview: [path: string];
  replace: [path: string, file: File];
  rename: [path: string, next: string];
  delete: [path: string];
  newFolder: [name: string];
}>();

const rows = computed(() => treeRows(props.files, props.folder));
const open = ref<Record<string, boolean>>({});
const renaming = ref<string | null>(null);
const renameText = ref('');
const deleting = ref<string | null>(null);
const replacing = ref<string | null>(null);
const picker = ref<HTMLInputElement | null>(null);
const folderOpen = ref(false);
const folderName = ref('');

const empty = computed(() =>
  props.mode === 'expected'
    ? 'No expected files yet. Add the files a correct agent would leave.'
    : props.mode === 'home'
      ? 'No home files. The agent starts with an empty memory.'
      : 'No workspace files. The agent starts with an empty workspace.',
);

function actions(file: DraftFileView): string[] {
  const preview = isPreviewable(file.path) ? ['Preview'] : [];
  if (props.mode === 'expected') return [...preview, 'Replace', 'Delete'];
  return [...preview, 'Replace', 'Rename', 'Delete'];
}

async function act(action: string, file: DraftFileView): Promise<void> {
  if (action === 'Preview') {
    open.value[file.path] = !open.value[file.path];
    if (open.value[file.path]) emit('preview', file.path);
  } else if (action === 'Replace') {
    replacing.value = file.path;
    picker.value?.click();
  } else if (action === 'Rename') {
    renaming.value = file.path;
    renameText.value = insideFolder(file.path, props.folder);
    await nextTick();
    document.getElementById(`rename-${file.sha256}`)?.focus();
  } else if (action === 'Delete') {
    deleting.value = file.path;
  }
}

function commitRename(file: DraftFileView): void {
  const next = renameText.value.trim();
  renaming.value = null;
  if (next && next !== insideFolder(file.path, props.folder))
    emit('rename', file.path, `${props.folder}/${next}`);
}

function onPicked(event: Event): void {
  const el = event.target as HTMLInputElement;
  const file = el.files?.[0];
  el.value = '';
  if (file && replacing.value) emit('replace', replacing.value, file);
  replacing.value = null;
}

function confirmDelete(path: string): void {
  deleting.value = null;
  emit('delete', path);
}

function addFolder(): void {
  const name = folderName.value.trim().replace(/^\/+|\/+$/g, '');
  folderOpen.value = false;
  folderName.value = '';
  if (name) emit('newFolder', name);
}
</script>

<template>
  <div class="flex w-full flex-col gap-8" :data-testid="`file-tree-${mode}`">
    <EditorNote v-if="files.length === 0" tone="info">{{ empty }}</EditorNote>
    <div v-else class="overflow-x-auto rounded-4 border border-border bg-surface">
      <table class="dt th30 static w-full">
        <thead>
          <tr>
            <th>
              {{
                mode === 'expected' ? 'Path a correct agent leaves' : 'Path as the agent sees it'
              }}
            </th>
            <th>Type</th>
            <th class="text-right">Size</th>
            <th>Hash</th>
            <th class="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.label">
            <tr v-if="row.kind === 'folder'">
              <td colspan="5" class="font-mono text-12 whitespace-normal text-text-2 wrap-anywhere">
                ▾ {{ row.label }}
              </td>
            </tr>
            <template v-else-if="row.file">
              <tr :data-path="row.file.path">
                <td
                  class="font-mono text-12 whitespace-normal wrap-anywhere"
                  :class="row.nested ? 'pl-34' : ''"
                  :title="row.file.path"
                >
                  <input
                    v-if="renaming === row.file.path"
                    :id="`rename-${row.file.sha256}`"
                    v-model="renameText"
                    class="input sm w-full font-mono"
                    :aria-label="`New name for ${row.file.path}`"
                    @keydown.enter.prevent="commitRename(row.file)"
                    @keydown.esc.prevent="renaming = null"
                    @blur="commitRename(row.file)"
                  />
                  <PathText v-else :path="row.label" />
                </td>
                <td class="text-text-2">{{ row.file.typeLabel }}</td>
                <td class="text-right text-text-2">{{ formatBytes(row.file.sizeBytes) }}</td>
                <td>
                  <span class="tag" :title="row.file.sha256">{{
                    shortHash(row.file.sha256, 8)
                  }}</span>
                </td>
                <td class="text-right whitespace-nowrap">
                  <template v-if="deleting === row.file.path">
                    <span class="mr-6 text-12 text-fail-text">Delete {{ row.label }}?</span>
                    <button
                      type="button"
                      class="btn danger h-24 px-6 text-12"
                      @click="confirmDelete(row.file.path)"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      class="btn ghost h-24 px-6 text-12"
                      @click="deleting = null"
                    >
                      Keep
                    </button>
                  </template>
                  <template v-else>
                    <button
                      v-for="a in actions(row.file)"
                      :key="a"
                      type="button"
                      class="btn ghost h-24 px-6 text-12"
                      :disabled="readonly && a !== 'Preview'"
                      :aria-expanded="a === 'Preview' ? !!open[row.file.path] : undefined"
                      @click="act(a, row.file)"
                    >
                      {{ a }}
                    </button>
                  </template>
                </td>
              </tr>
              <tr v-if="notes[row.file.path]">
                <td colspan="5" class="h-auto px-12 pt-6 pb-8 whitespace-normal">
                  <EditorNote tone="warning"><CodeText :text="notes[row.file.path]!" /></EditorNote>
                </td>
              </tr>
              <tr v-if="collidesWithDocs(row.file)">
                <td colspan="5" class="h-auto px-12 pt-6 pb-8 whitespace-normal">
                  <EditorNote
                    tone="warning"
                    lead="Files under docs/ can collide with configuration documents,"
                    >which are placed at /workspace/docs/.</EditorNote
                  >
                </td>
              </tr>
              <tr v-if="open[row.file.path]">
                <td colspan="5" class="h-auto px-12 pt-4 pb-12 whitespace-normal">
                  <template v-if="previews[row.file.path]">
                    <div class="mb-6 text-12 text-text-3">
                      Preview · first {{ previews[row.file.path]!.rows.length }} of
                      {{ plural(previews[row.file.path]!.totalRows, 'row') }}
                    </div>
                    <TablePreviewTable
                      :preview="previews[row.file.path]!"
                      :label="`First rows of ${row.label}`"
                    />
                  </template>
                  <span v-else-if="previews[row.file.path] === null" class="text-12 text-text-3"
                    >No preview for this file.</span
                  >
                  <span
                    v-else
                    class="block h-10 w-200 animate-shimmer rounded-3 bg-surface-3"
                    aria-busy="true"
                  />
                </td>
              </tr>
            </template>
          </template>
        </tbody>
      </table>
    </div>
    <input
      ref="picker"
      type="file"
      class="hidden"
      tabindex="-1"
      aria-hidden="true"
      @change="onPicked"
    />
    <div v-if="mode === 'workspace' && !readonly" class="flex flex-wrap items-center gap-8">
      <template v-if="folderOpen">
        <input
          v-model="folderName"
          class="input w-200 font-mono text-12"
          aria-label="Folder name"
          placeholder="docs"
          @keydown.enter.prevent="addFolder"
          @keydown.esc.prevent="folderOpen = false"
        />
        <button type="button" class="btn" @click="addFolder">Add folder</button>
        <button type="button" class="btn ghost" @click="folderOpen = false">Cancel</button>
      </template>
      <button v-else type="button" class="btn" @click="folderOpen = true">New folder</button>
    </div>
  </div>
</template>
