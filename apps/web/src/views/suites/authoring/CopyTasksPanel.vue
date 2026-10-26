<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { errorMessage } from '@/api/client';
import { plural } from '@/lib/format';
import { useDraftStore } from '@/stores/draft';
import { useSuitesStore } from '@/stores/suites';
import { draftTaskRoute } from './editorRoutes';

/**
 * Copy tasks from another suite (SA.3, the empty draft): a suite, then the tasks to copy at
 * its current version, files and all (CreateDraftTaskRequest `copy`). The board draws only
 * the button; this panel and its copy are the engineers'.
 */
const props = defineProps<{ folder: string }>();
const emit = defineEmits<{ done: [] }>();

const suites = useSuitesStore();
const drafts = useDraftStore();
const router = useRouter();

const suiteId = ref('');
const picked = ref<string[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);

const others = computed(() =>
  suites.list.filter(
    (s) => s.lastLoad.outcome !== 'missing' && !s.path.endsWith(`/${props.folder}`),
  ),
);
const chosen = computed(() => suites.list.find((s) => s.suiteId === suiteId.value) ?? null);
const tasks = computed(() => (suiteId.value ? (suites.suites[suiteId.value]?.tasks ?? []) : []));

onMounted(async () => {
  if (!suites.listLoaded) await suites.loadList();
  suiteId.value = others.value[0]?.suiteId ?? '';
});
watch(suiteId, async (id) => {
  picked.value = [];
  if (id) await suites.loadSuite(id).catch((err: unknown) => (error.value = errorMessage(err)));
});

async function copy(): Promise<void> {
  const from = chosen.value;
  if (!from || picked.value.length === 0) return;
  busy.value = true;
  error.value = null;
  try {
    const folderName = from.path.replace(/\/+$/, '').split('/').pop() ?? from.name;
    const result = await drafts.addTask(props.folder, {
      kind: 'copy',
      suite: folderName,
      versionNumber: from.versionNumber,
      keys: picked.value,
    });
    emit('done');
    if (result.keys.length === 1) await router.push(draftTaskRoute(props.folder, result.keys[0]!));
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div
    class="flex flex-col gap-10 rounded-6 border border-border bg-surface px-16 py-12"
    data-testid="copy-tasks"
  >
    <label class="flex flex-col gap-4">
      <span class="text-12 font-medium text-text-2">Suite</span>
      <select v-model="suiteId" class="input font-mono">
        <option v-for="s in others" :key="s.suiteId" :value="s.suiteId">
          {{ s.name }} · v{{ s.versionNumber }} · {{ plural(s.taskCount, 'task') }}
        </option>
      </select>
    </label>
    <fieldset
      v-if="tasks.length"
      class="m-0 flex max-h-240 flex-col gap-4 overflow-auto border-0 p-0"
    >
      <legend class="mb-4 text-12 font-medium text-text-2">Tasks to copy</legend>
      <label v-for="t in tasks" :key="t.key" class="flex items-center gap-8">
        <input v-model="picked" type="checkbox" class="size-14 accent-accent" :value="t.key" />
        <span class="font-mono text-12">{{ t.key }}</span>
        <span class="truncate text-12 text-text-3">{{ t.summary }}</span>
      </label>
    </fieldset>
    <span v-else-if="others.length === 0" class="text-12 text-text-3"
      >There is no other suite to copy from.</span
    >
    <span v-if="error" role="alert" class="text-12 text-fail-text">{{ error }}</span>
    <div class="flex items-center gap-8">
      <button
        type="button"
        class="btn primary"
        :disabled="busy || picked.length === 0"
        @click="copy"
      >
        Copy {{ picked.length ? plural(picked.length, 'task') : 'tasks' }}
      </button>
      <button type="button" class="btn ghost" @click="emit('done')">Cancel</button>
    </div>
  </div>
</template>
