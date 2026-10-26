<script setup lang="ts">
import { computed, ref } from 'vue';
import { HOME_SEED_PATHS } from '@hermes-evals/shared';
import type { DraftUploadKind } from '@/api/types/authoring';
import FileDropZone from '@/components/authoring/files/FileDropZone.vue';
import TaskFileTree from '@/components/authoring/files/TaskFileTree.vue';
import { insideFolder, kindFolder } from '@/components/authoring/files/fileRows';
import type { DroppedFile } from '@/components/authoring/files/dropFiles';
import { useDraftTaskStore } from '@/stores/draftTask';
import { useDraftTaskToolsStore } from '@/stores/draftTaskTools';

/**
 * The drop zone and file list of one kind of task file (SA.4 to SA.6): workspace files,
 * home seeds, the expected workspace or the expected home. Uploads, Replace, Rename and
 * Delete go through the tools store; a file holding a reference value carries the API's
 * warning. Only memories/MEMORY.md and memories/USER.md may seed the home (plan 4.1).
 */
const props = defineProps<{ kind: DraftUploadKind }>();
const task = useDraftTaskStore();
const tools = useDraftTaskToolsStore();
const prefix = ref('');

const folder = computed(() =>
  kindFolder(props.kind, task.form?.expectedWorkspace ?? null, task.form?.expectedHome ?? null),
);
const files = computed(() => task.detail?.files.filter((f) => f.kind === props.kind) ?? []);
const notes = computed(() =>
  Object.fromEntries(
    (task.detail?.readiness.issues ?? [])
      .filter((i) => i.rule === 'reference_leak' && i.target.field)
      .map((i) => [i.target.field!, i.message]),
  ),
);
const mode = computed(() =>
  props.kind === 'fixture' ? 'workspace' : props.kind === 'home_seed' ? 'home' : 'expected',
);
const target = computed(
  () =>
    ({
      fixture: 'workspace files',
      home_seed: 'home files',
      expected: 'the expected workspace',
      expected_home: 'the expected home',
    })[props.kind],
);
const MEMORY_NAMES = HOME_SEED_PATHS.map((p) => p.split('/').pop()!);

function add(items: DroppedFile[]): void {
  if (props.kind === 'home_seed') {
    const refused = items.filter((i) => !MEMORY_NAMES.includes(i.file.name));
    for (const i of refused)
      tools.rejectFile(
        i.file,
        'home_seed',
        'Home files are `memories/MEMORY.md` and `memories/USER.md` only.',
      );
    items = items.filter((i) => MEMORY_NAMES.includes(i.file.name));
  }
  const at = prefix.value ? `${prefix.value}/` : '';
  if (items.length) void tools.upload(items, props.kind, at);
}

function replace(path: string, file: File): void {
  void tools.upload([{ file, path: insideFolder(path, folder.value) }], props.kind);
}
</script>

<template>
  <FileDropZone
    :target="target"
    :uploads="tools.uploads.filter((u) => u.kind === kind)"
    :rejected="tools.rejected.filter((r) => r.kind === kind)"
    :disabled="task.locked"
    :folder="prefix ? `${prefix}/` : null"
    @files="add"
    @cancel="tools.cancelUpload"
    @dismiss="tools.dismissRejected"
    @clear-folder="prefix = ''"
  />
  <TaskFileTree
    :mode="mode"
    :files="files"
    :folder="folder"
    :notes="notes"
    :previews="tools.previews"
    :readonly="task.locked"
    @preview="tools.loadPreview"
    @replace="replace"
    @rename="tools.renameFile"
    @delete="tools.removeFile"
    @new-folder="prefix = $event"
  />
</template>
