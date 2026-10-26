<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter, type RouteLocationRaw } from 'vue-router';
import { errorMessage } from '@/api/client';
import type { ReadinessRuleResult, ReadinessTarget } from '@/api/types/authoring';
import { hhmm } from '@/components/authoring/draft-bar/draftText';
import { primaryLines, SECOND_PRIMARY } from '@/components/authoring/editors/editorText';
import YamlEditor from '@/components/authoring/editors/YamlEditor.vue';
import TaskFolderTable from '@/components/authoring/files/TaskFolderTable.vue';
import ReadinessPanel from '@/components/authoring/readiness/ReadinessPanel.vue';
import PageContainer from '@/components/layout/PageContainer.vue';
import ZoneLabel from '@/components/suites/ZoneLabel.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { ROUTE_NAMES } from '@/router';
import { useDraftStore } from '@/stores/draft';
import { useDraftTaskStore } from '@/stores/draftTask';
import { useDraftTaskToolsStore } from '@/stores/draftTaskTools';
import { draftTaskRoute, suiteDraftRoute, type EditorTab } from './editorRoutes';
import LeaveDuringUpload from './LeaveDuringUpload.vue';
import TaskEditorForm from './TaskEditorForm.vue';
import TaskEditorHeader from './TaskEditorHeader.vue';
import TaskEditorSkeleton from './TaskEditorSkeleton.vue';

/**
 * The task editor (SA.4 to SA.8, SA.13): one task of a suite draft in three tabs that edit
 * the same folder, Form, Files and task.yaml, beside the sticky ReadinessPanel. Every change
 * saves itself into the draft (stores/draftTask.ts); switching tabs first sends what is
 * waiting, so each tab shows the file as saved. Leaving while an upload runs asks first;
 * leaving otherwise sends what is waiting.
 */
const props = withDefaults(defineProps<{ folder: string; taskKey: string; tab?: EditorTab }>(), {
  tab: 'form',
});

const task = useDraftTaskStore();
const tools = useDraftTaskToolsStore();
const drafts = useDraftStore();
const router = useRouter();

const form = ref<InstanceType<typeof TaskEditorForm> | null>(null);
const yaml = ref<InstanceType<typeof YamlEditor> | null>(null);
const actionError = ref<string | null>(null);
const busy = ref(false);
const leaving = ref<RouteLocationRaw | null>(null);
let leaveAnyway = false;

const detail = computed(() => (task.folder === props.folder ? task.detail : null));
const draft = computed(() => drafts.drafts[props.folder] ?? null);
/** Both primary lines while task.yaml marks two checks primary (SA.5); the lock marks the second. */
const markedLines = computed(() =>
  detail.value?.formLock?.message.startsWith(SECOND_PRIMARY) ? primaryLines(task.taskYaml) : [],
);

async function open(): Promise<void> {
  // The same task again (back from the suite, or the address following a rename): fetch it
  // again, keeping what was tried and uploaded.
  if (task.folder === props.folder && task.key === props.taskKey && task.detail) {
    await task.reload();
    return;
  }
  tools.reset();
  await task.open(props.folder, props.taskKey);
  if (!drafts.drafts[props.folder]) void drafts.load(props.folder).catch(() => undefined);
  void tools.refreshReferenceTries();
}
watch(
  () => [props.folder, props.taskKey],
  () => void open(),
  { immediate: true },
);
// A rename moves the task: the address follows it.
watch(
  () => task.key,
  (key) => {
    if (key && task.folder === props.folder && key !== props.taskKey)
      void router.replace(draftTaskRoute(props.folder, key, props.tab));
  },
);

const tabs: Array<{ id: EditorTab; label: string }> = [
  { id: 'form', label: 'Form' },
  { id: 'files', label: 'Files' },
  { id: 'yaml', label: 'task.yaml' },
];
async function setTab(next: EditorTab): Promise<void> {
  await task.flush();
  await router.replace(draftTaskRoute(props.folder, task.key ?? props.taskKey, next));
}

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
  { label: 'Suites', to: { name: ROUTE_NAMES.suites } },
  { label: draft.value?.name ?? props.folder, to: suiteDraftRoute(props.folder) },
  { label: task.keyDraft || props.taskKey },
  { label: 'Edit' },
]);
const taskLabel = computed(() => {
  const d = detail.value;
  if (!d) return '';
  const when = task.status === 'saving' ? 'saving…' : `saved ${hhmm(d.updatedAt)}`;
  return `${d.key} · draft · ${when}`;
});
const overrides = computed<Partial<Record<'file_limits', ReadinessRuleResult>>>(() => {
  const big = tools.rejected.find((r) => r.reason === 'The limit is 25 MB per file.');
  if (!big) return {};
  return {
    file_limits: {
      rule: 'file_limits',
      status: 'problem',
      message: `\`${big.name}\` is over 25 MB.`,
      target: { section: 'workspace', field: null },
    },
  };
});
const transcript = computed(
  () =>
    detail.value?.selfCheck?.results.find((r) => r.status === 'error' && r.transcript)
      ?.transcript ?? null,
);
const workerChecks = computed(
  () =>
    task.form?.checks.filter((c) => c.type === 'file_check' || c.type === 'verifier_script')
      .length ?? 0,
);
const yamlPath = computed(() => `${detail.value?.key ?? props.taskKey}/task.yaml`);

async function fix(target: ReadinessTarget): Promise<void> {
  if (target.section === 'yaml') {
    await setTab('yaml');
    const lock = detail.value?.formLock;
    if (lock?.line) yaml.value?.focusAt(lock.line, lock.column ?? 1);
    return;
  }
  if (props.tab !== 'form') await setTab('form');
  await form.value?.reveal(target);
}

async function act(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    await action();
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}
const duplicate = () =>
  act(async () => {
    await task.flush();
    const result = await drafts.addTask(props.folder, {
      kind: 'duplicate',
      from: task.key ?? props.taskKey,
    });
    await router.push(draftTaskRoute(props.folder, result.keys[0]!));
  });
const remove = () =>
  act(async () => {
    await drafts.removeTask(props.folder, task.key ?? props.taskKey);
    leaveAnyway = true;
    await router.push(suiteDraftRoute(props.folder));
  });
const revert = () => act(() => task.revert());

onBeforeRouteLeave(async (to) => {
  if (tools.uploading && !leaveAnyway) {
    leaving.value = to;
    return false;
  }
  leaveAnyway = false;
  await task.flush();
  return true;
});
function leaveNow(): void {
  const to = leaving.value;
  leaving.value = null;
  tools.cancelAllUploads();
  leaveAnyway = true;
  if (to) void router.push(to);
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (tools.uploading || task.status !== 'saved') event.preventDefault();
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
</script>

<template>
  <PageContainer variant="detail" :gap="14">
    <template v-if="detail">
      <TaskEditorHeader
        :detail="detail"
        :shown-key="task.keyDraft || detail.key"
        :status="task.status"
        :breadcrumbs="breadcrumbs"
        :back-to="suiteDraftRoute(folder)"
        :busy="busy"
        @duplicate="duplicate"
        @revert="revert"
        @remove="remove"
      />
      <LeaveDuringUpload
        v-if="leaving"
        :uploads="tools.uploads"
        @leave="leaveNow"
        @stay="leaving = null"
      />
      <ErrorBanner v-if="actionError" :detail="actionError" title="That did not work" />
      <ErrorBanner
        v-if="task.saveError"
        title="The last change was not saved to the draft"
        :detail="task.saveError"
        hint="It is kept on this page. Try again sends it."
        retry-label="Try again"
        @retry="task.flush()"
      />
      <nav class="flex items-end gap-4 border-b border-border" aria-label="Task views">
        <button
          v-for="t in tabs"
          :key="t.id"
          type="button"
          class="-mb-1 inline-flex h-36 items-center border-0 border-b-2 bg-transparent px-12 font-medium"
          :class="tab === t.id ? 'border-accent text-text' : 'border-transparent text-text-2'"
          :aria-current="tab === t.id ? 'page' : undefined"
          @click="setTab(t.id)"
        >
          {{ t.label }}
        </button>
      </nav>
      <div class="flex items-start gap-24 max-lg:flex-col">
        <div class="flex min-w-0 flex-1 flex-col gap-12 max-lg:w-full">
          <TaskEditorForm v-if="tab === 'form'" ref="form" @open-yaml="setTab('yaml')" />
          <template v-else-if="tab === 'files'">
            <p class="m-0 text-text-2">
              The whole task folder. Only the prompt and the workspace files ever reach the agent;
              everything else stays outside the run.
            </p>
            <TaskFolderTable
              :files="detail.files"
              :sources="tools.sources"
              :previews="tools.previews"
              :readonly="task.locked"
              @edit-in-form="setTab('form')"
              @open-yaml="setTab('yaml')"
              @view="tools.loadSource"
              @preview="tools.loadPreview"
              @delete="tools.removeFile"
            />
          </template>
          <template v-else>
            <div class="flex items-center gap-8">
              <ZoneLabel zone="hidden" /><span class="text-12 text-text-3"
                >Read by the platform only</span
              >
            </div>
            <YamlEditor
              ref="yaml"
              :model-value="task.taskYaml"
              :path="yamlPath"
              :error="detail.formLock"
              :marked-lines="markedLines"
              @update:model-value="task.editYaml"
            />
          </template>
        </div>
        <aside
          class="sticky top-16 w-360 flex-none self-start max-lg:static max-lg:w-full"
          aria-label="Readiness"
        >
          <ReadinessPanel
            :readiness="detail.readiness"
            :task-label="taskLabel"
            :self-check-state="tools.selfCheckState"
            :self-check-error="tools.selfCheckError"
            :worker-checks="workerChecks"
            :transcript="transcript"
            :overrides="overrides"
            :readonly="task.locked"
            @fix="fix"
            @run-self-check="tools.runSelfCheck"
          />
        </aside>
      </div>
    </template>
    <TaskEditorSkeleton
      v-else
      :folder="folder"
      :task-key="taskKey"
      :error="task.folder === folder ? task.loadError : null"
      :saved-at="draft ? hhmm(draft.updatedAt) : null"
      @retry="task.reload()"
    />
  </PageContainer>
</template>
