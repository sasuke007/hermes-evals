<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DraftFileView } from '@/api/types/authoring';
import type { TablePreview } from '@/api/types/suites';
import ZoneLabel from '@/components/suites/ZoneLabel.vue';
import TablePreviewTable from '@/components/suites/TablePreviewTable.vue';
import { formatBytes, plural, shortHash } from '@/lib/format';
import ScriptSource from '../checks/ScriptSource.vue';
import EyeIcon from './EyeIcon.vue';
import PathText from './PathText.vue';
import { folderActions, folderDetail, folderTotal, type FileAction } from './fileRows';

/**
 * The Files tab (Components 5, TaskFileTree, folder mode; SA.6): every file of the task
 * folder grouped by who can see it, Visible to the agent, Hidden from the agent (hatched
 * rows) and Other files, so the isolation boundary reads at a glance. Each row has its
 * chip, size, short hash and the actions its kind allows; a verifier script is "Hidden ·
 * runs in the worker · edit on disk" with View and Copy path. The board's "Download task
 * folder (.zip)" is left out: no endpoint serves one task's folder.
 */
const props = withDefaults(
  defineProps<{
    files: DraftFileView[];
    sources?: Record<string, { text: string | null; error: string | null }>;
    previews?: Record<string, TablePreview | null>;
    readonly?: boolean;
  }>(),
  { sources: () => ({}), previews: () => ({}), readonly: false },
);
const emit = defineEmits<{
  editInForm: [file: DraftFileView];
  openYaml: [];
  view: [path: string];
  preview: [path: string];
  replace: [file: DraftFileView];
  rename: [file: DraftFileView];
  delete: [path: string];
}>();

const open = ref<Record<string, boolean>>({});
const deleting = ref<string | null>(null);
const copied = ref<string | null>(null);

const groups = computed(() =>
  (
    [
      ['agent', 'Visible to the agent'],
      ['hidden', 'Hidden from the agent'],
      ['other', 'Other files'],
    ] as const
  )
    .map(([visibility, label]) => ({
      visibility,
      label,
      files: props.files.filter((f) => f.visibility === visibility),
    }))
    .filter((g) => g.files.length > 0),
);

async function act(action: FileAction, file: DraftFileView): Promise<void> {
  if (action === 'Edit in form') emit('editInForm', file);
  else if (action === 'Open task.yaml tab') emit('openYaml');
  else if (action === 'View' || action === 'Preview') {
    open.value[file.path] = !open.value[file.path];
    if (open.value[file.path] && action === 'View') emit('view', file.path);
    else if (open.value[file.path]) emit('preview', file.path);
  } else if (action === 'Replace') emit('replace', file);
  else if (action === 'Rename') emit('rename', file);
  else if (action === 'Delete') deleting.value = file.path;
  else if (action === 'Copy path') {
    try {
      await navigator.clipboard?.writeText(file.path);
    } catch {
      /* the path is on screen either way */
    }
    copied.value = file.path;
    setTimeout(() => (copied.value = copied.value === file.path ? null : copied.value), 1500);
  }
}

function confirmDelete(path: string): void {
  deleting.value = null;
  emit('delete', path);
}

const HATCH =
  'bg-[repeating-linear-gradient(135deg,var(--surface)_0_10px,var(--surface-2)_10px_20px)]';
</script>

<template>
  <div class="overflow-x-auto rounded-4 border border-border bg-surface" data-testid="task-folder">
    <table class="dt th30 static w-full">
      <thead>
        <tr>
          <th>Path in the task folder</th>
          <th>Visibility</th>
          <th class="text-right">Size</th>
          <th>Hash</th>
          <th class="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="group in groups" :key="group.visibility">
          <tr>
            <td colspan="5" class="h-34 bg-surface-2">
              <span class="flex items-center gap-10">
                <ZoneLabel
                  v-if="group.visibility !== 'other'"
                  :zone="group.visibility === 'agent' ? 'visible' : 'hidden'"
                />
                <b v-else class="text-12">{{ group.label }}</b>
                <span class="text-12 text-text-3">{{ plural(group.files.length, 'file') }}</span>
              </span>
            </td>
          </tr>
          <template v-for="file in group.files" :key="file.path">
            <tr
              :class="group.visibility === 'hidden' ? HATCH : ''"
              :data-path="file.path"
              :data-kind="file.kind"
            >
              <td class="font-mono text-12 font-medium whitespace-normal wrap-anywhere">
                <PathText :path="file.path" />
              </td>
              <td class="whitespace-normal">
                <span class="inline-flex flex-wrap items-center gap-x-6">
                  <span
                    v-if="file.visibility === 'agent'"
                    class="inline-flex h-20 items-center gap-5 rounded-3 border border-border bg-surface px-7 text-12 font-medium whitespace-nowrap text-text-2"
                    ><EyeIcon :size="12" />Agent sees</span
                  >
                  <span
                    v-else-if="file.visibility === 'hidden'"
                    class="inline-flex h-20 items-center gap-5 rounded-3 bg-text px-7 text-12 font-medium whitespace-nowrap text-bg"
                    ><EyeIcon hidden :size="12" />Hidden</span
                  >
                  <span v-if="file.visibility === 'other'" class="text-12 text-text-3">{{
                    folderDetail(file)
                  }}</span>
                  <span
                    v-else-if="folderDetail(file)"
                    class="font-mono text-12 text-text-2 wrap-anywhere"
                    >·&nbsp;<PathText :path="folderDetail(file)"
                  /></span>
                  <b v-if="file.kind === 'verifier'" class="text-12 whitespace-nowrap"
                    >· edit on disk</b
                  >
                </span>
              </td>
              <td class="text-right text-text-2">{{ formatBytes(file.sizeBytes) }}</td>
              <td>
                <span class="tag" :title="file.sha256">{{ shortHash(file.sha256, 8) }}</span>
              </td>
              <td class="text-right whitespace-nowrap">
                <template v-if="deleting === file.path">
                  <span class="mr-6 text-12 text-fail-text">Delete {{ file.path }}?</span>
                  <button
                    type="button"
                    class="btn danger h-24 px-6 text-12"
                    @click="confirmDelete(file.path)"
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
                    v-for="a in folderActions(file)"
                    :key="a"
                    type="button"
                    class="btn ghost h-24 px-6 text-12"
                    :disabled="readonly && (a === 'Replace' || a === 'Rename' || a === 'Delete')"
                    :aria-expanded="a === 'View' || a === 'Preview' ? !!open[file.path] : undefined"
                    @click="act(a, file)"
                  >
                    {{ a === 'Copy path' && copied === file.path ? 'Copied' : a }}
                  </button>
                </template>
              </td>
            </tr>
            <tr v-if="open[file.path]">
              <td colspan="5" class="h-auto px-12 pt-4 pb-12 whitespace-normal">
                <ScriptSource
                  v-if="file.kind === 'verifier'"
                  :file="file"
                  :source="sources[file.path]?.text ?? null"
                  :error="sources[file.path]?.error ?? null"
                />
                <TablePreviewTable
                  v-else-if="previews[file.path]"
                  :preview="previews[file.path]!"
                  :label="`First rows of ${file.path}`"
                />
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
    <div class="flex items-center justify-between gap-12 border-t border-border px-14 py-10">
      <span class="text-text-2" data-testid="folder-total">{{ folderTotal(files) }}</span>
    </div>
  </div>
</template>
