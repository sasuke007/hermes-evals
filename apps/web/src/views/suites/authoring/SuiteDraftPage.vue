<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { errorMessage } from '@/api/client';
import { suiteVersionZip } from '@/api/drafts';
import AddTaskMenu from '@/components/authoring/draft-bar/AddTaskMenu.vue';
import DraftDetailsForm from '@/components/authoring/draft-bar/DraftDetailsForm.vue';
import DraftTaskTable from '@/components/authoring/draft-bar/DraftTaskTable.vue';
import SuiteDraftBar from '@/components/authoring/draft-bar/SuiteDraftBar.vue';
import DraftConflictResolver from '@/components/authoring/conflict/DraftConflictResolver.vue';
import { rebaseRequest, type ConflictChoices } from '@/components/authoring/conflict/conflict';
import PageContainer from '@/components/layout/PageContainer.vue';
import SuiteHistoryPanel from '@/components/suites/SuiteHistoryPanel.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { formatDateTime, plural, shortHash } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useDraftStore } from '@/stores/draft';
import { useSuitesStore } from '@/stores/suites';
import { importTasksLocation, saveDraftLocation } from '@/views/suites/authoringRoutes';
import CopyTasksPanel from './CopyTasksPanel.vue';
import DraftPageStates from './DraftPageStates.vue';
import { draftTaskRoute } from './editorRoutes';

/**
 * A suite in draft mode (SA.3; SuiteDetail board, draft tweaks; SA.12 and SA.13 where they
 * concern this page): the header with Add task, Edit details, Download .zip and Reload from
 * disk, the SuiteDraftBar, the details form, the conflict resolver when the folder moved past
 * the base, the task table with drag handles, change and readiness, and History. A new
 * suite's empty draft asks for its first task. Nothing is written to ./suites until Review
 * and save. A folder with no draft offers to start one (copy no board draws).
 */
const props = withDefaults(defineProps<{ folder: string; details?: boolean }>(), {
  details: false,
});

const store = useDraftStore();
const suites = useSuitesStore();
const router = useRouter();

const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const busy = ref(false);
const detailsOpen = ref(props.details);
const choices = ref<ConflictChoices>({});
const copying = ref(false);

const draft = computed(() => store.drafts[props.folder] ?? null);
const missing = computed(() => !!store.missing[props.folder]);
const write = computed(() => store.writes[props.folder] ?? { saving: false, error: null });
const base = computed(() => draft.value?.base ?? null);
/**
 * The version the header names: the folder's current one while the draft conflicts with it
 * (SA.12: "v7 · loaded 16:40", "v7 has 12"), else the draft's base.
 */
const shown = computed(() => draft.value?.conflict?.current ?? base.value);
/**
 * Every version of the folder, fetched for the version shown: during a conflict that is the
 * newer one, so History lists the version the bar names (the base's list, kept from before
 * the reload or the save that found it, would not). The base's list stands in meanwhile.
 */
const history = computed(() => {
  const at = (id: string | undefined) => (id ? (suites.histories[id] ?? null) : null);
  return at(shown.value?.suiteId) ?? at(base.value?.suiteId);
});
const shownDetail = computed(() =>
  shown.value ? (suites.suites[shown.value.suiteId] ?? null) : null,
);
const shownLoadedAt = computed(
  () => draft.value?.conflict?.current.loadedAt ?? shownDetail.value?.loadedAt ?? null,
);
watch(
  () => draft.value?.conflict?.current.suiteId,
  (id) => {
    if (id) void Promise.allSettled([suites.loadSuite(id), suites.loadHistory(id, true)]);
  },
  { immediate: true },
);
const liveTasks = computed(() => draft.value?.tasks.filter((t) => t.state !== 'removed') ?? []);

async function load(): Promise<void> {
  error.value = null;
  try {
    const view = await store.load(props.folder);
    if (view?.base) {
      await Promise.allSettled([
        suites.loadSuite(view.base.suiteId),
        suites.loadHistory(view.base.suiteId),
      ]);
    }
  } catch (err) {
    error.value = errorMessage(err);
  }
}
watch(
  () => props.folder,
  () => void load(),
  { immediate: true },
);
watch(
  () => props.details,
  (open) => (detailsOpen.value = open),
);

onBeforeRouteLeave(async () => {
  await store.flushDetails(props.folder);
});

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
  { label: 'Suites', to: { name: ROUTE_NAMES.suites } },
  { label: draft.value?.name ?? props.folder },
]);

const countLine = computed(() => {
  const d = draft.value;
  if (!d) return '';
  if (!d.base || !shown.value) return plural(liveTasks.value.length, 'task');
  const count = shownDetail.value?.taskCount;
  return `${plural(liveTasks.value.length, 'task')} in the draft${count !== undefined ? ` · v${shown.value.versionNumber} has ${count}` : ''}`;
});
const zip = computed(() =>
  shown.value ? suiteVersionZip(props.folder, shown.value.versionNumber) : null,
);

async function run(action: () => Promise<void>): Promise<void> {
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

const start = () => run(async () => void (await store.open(props.folder)));

const addBlank = () =>
  run(async () => {
    const result = await store.addTask(props.folder, { kind: 'blank' });
    await router.push(draftTaskRoute(props.folder, result.keys[0]!));
  });

const duplicate = (from: string) =>
  run(async () => {
    const result = await store.addTask(props.folder, { kind: 'duplicate', from });
    await router.push(draftTaskRoute(props.folder, result.keys[0]!));
  });

const remove = (key: string) => run(async () => void (await store.removeTask(props.folder, key)));
const undo = (key: string) => run(() => store.undoRemove(props.folder, key));
const reorder = (order: string[]) => store.reorder(props.folder, order);

function closeDetails(): void {
  detailsOpen.value = false;
  void store.flushDetails(props.folder);
}

const discard = () =>
  run(async () => {
    const baseId = base.value?.suiteId ?? null;
    await store.discard(props.folder);
    await router.push(
      baseId ? { name: ROUTE_NAMES.suite, params: { id: baseId } } : { name: ROUTE_NAMES.suites },
    );
  });

const combine = () =>
  run(async () => {
    const conflict = draft.value?.conflict;
    if (!conflict) return;
    const outcome = await store.rebase(props.folder, rebaseRequest(conflict, choices.value));
    if (outcome.kind === 'rebased') {
      choices.value = {};
      const id = outcome.draft.base?.suiteId;
      if (id) await Promise.allSettled([suites.loadSuite(id, true), suites.loadHistory(id, true)]);
    }
  });

function reviewDifferences(): void {
  const current = draft.value?.conflict?.current;
  if (current) void router.push({ name: ROUTE_NAMES.suite, params: { id: current.suiteId } });
}

const reload = () =>
  run(async () => {
    if (!draft.value) return;
    const result = await suites.reload(draft.value.path);
    if (!result && suites.reloadError) throw new Error(suites.reloadError);
    await load();
  });
</script>

<template>
  <PageContainer variant="detail">
    <DraftPageStates
      v-if="!draft"
      :folder="folder"
      :error="error"
      :missing="missing"
      :busy="busy"
      :action-error="actionError"
      @retry="load"
      @start="start"
    />
    <template v-else>
      <PageHeader :title="draft.name" :breadcrumbs="breadcrumbs" mono>
        <template #title-extra>
          <span v-if="!draft.base" class="chip bg-que-soft text-que-text">not saved yet</span>
          <span v-else-if="shown" class="font-mono font-semibold">v{{ shown.versionNumber }}</span>
          <span class="text-text-3" title="Author label from suite.yaml">{{
            shown ? shown.versionLabel : draft.versionLabel
          }}</span>
          <span v-if="draft.base && shown" class="tag" :title="shown.contentHash">{{
            shortHash(shown.contentHash)
          }}</span>
          <span class="text-text-2" data-testid="task-count">{{ countLine }}</span>
        </template>
        <template #meta>
          <p class="m-0 text-12 text-text-3" data-testid="suite-strip">
            <code>{{ draft.base ? draft.path : `${draft.path}/` }}</code> ·
            <template v-if="draft.base && shown"
              >v{{ shown.versionNumber
              }}<template v-if="shownLoadedAt">
                · loaded {{ formatDateTime(shownLoadedAt) }}</template
              ></template
            >
            <template v-else>not written yet: the folder is created when you save v1</template>
          </p>
        </template>
        <template #actions>
          <AddTaskMenu
            :keys="liveTasks.map((t) => t.key)"
            :import-to="importTasksLocation(folder)"
            :disabled="busy || !!draft.saving"
            @blank="addBlank"
            @duplicate="duplicate"
          />
          <button
            type="button"
            class="btn"
            :aria-expanded="detailsOpen"
            @click="detailsOpen = !detailsOpen"
          >
            Edit details
          </button>
          <a
            v-if="zip"
            class="btn"
            :href="zip.url"
            :download="zip.fileName"
            :title="`Downloads ${zip.fileName}, the files of the version on screen`"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.25"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 15V3" />
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="m7 10 5 5 5-5" /></svg
            >Download .zip
          </a>
          <button
            v-if="draft.base"
            type="button"
            class="btn"
            :disabled="busy || suites.busy"
            @click="reload"
          >
            {{ suites.isReloading(draft.path) ? 'Reloading…' : 'Reload from disk' }}
          </button>
        </template>
      </PageHeader>

      <SuiteDraftBar
        :draft="draft"
        :saving="write.saving"
        :choices="choices"
        :review-to="saveDraftLocation(folder)"
        :busy="busy"
        :error="actionError"
        @discard="discard"
        @combine="combine"
        @review-differences="reviewDifferences"
      />
      <ErrorBanner
        v-if="write.error"
        title="The last change was not saved to the draft"
        :detail="write.error"
        hint="It is kept on this page. Try again sends it."
        retry-label="Try again"
        @retry="store.flushDetails(folder)"
      />

      <DraftDetailsForm
        v-if="detailsOpen"
        :name="draft.name"
        :version-label="draft.versionLabel"
        :description="draft.description"
        :next-version="draft.nextVersion"
        :readonly="!!draft.saving"
        @label="store.editDetails(folder, { versionLabel: $event })"
        @description="store.editDetails(folder, { description: $event })"
        @done="closeDetails"
      />

      <DraftConflictResolver
        v-if="draft.conflict && draft.conflict.overlap.length"
        v-model:choices="choices"
        :draft="draft"
      />

      <div
        v-if="liveTasks.length === 0 && draft.tasks.length === 0"
        class="flex flex-col items-center gap-10 rounded-6 border border-dashed border-border-strong bg-surface px-24 py-48 text-center"
        data-testid="draft-empty"
      >
        <b class="text-15">Add your first task</b>
        <p class="m-0 max-w-520 text-text-2">
          A suite needs at least one task before it can be saved as v{{ draft.nextVersion }}.
        </p>
        <div class="mt-6 flex flex-wrap justify-center gap-8">
          <button type="button" class="btn primary" :disabled="busy" @click="addBlank">
            Blank task
          </button>
          <RouterLink class="btn" :to="importTasksLocation(folder)"
            >Import from CSV or JSONL</RouterLink
          >
          <button type="button" class="btn" :aria-expanded="copying" @click="copying = !copying">
            Copy tasks from another suite
          </button>
        </div>
        <CopyTasksPanel
          v-if="copying"
          :folder="folder"
          class="w-full max-w-640 text-left"
          @done="copying = false"
        />
        <p class="m-0 mt-8 text-12 text-text-3">
          Saved as files in <code>{{ draft.path }}/</code> on this machine. Edit them here or on
          disk, and commit them with git like any other file.
        </p>
      </div>
      <DraftTaskTable
        v-else
        :rows="draft.tasks"
        :path="draft.path"
        :base-version="draft.base?.versionNumber ?? null"
        :edit-to="(key: string) => draftTaskRoute(folder, key)"
        :readonly="!!draft.saving || busy"
        @reorder="reorder"
        @duplicate="duplicate"
        @remove="remove"
        @undo="undo"
      />

      <SuiteHistoryPanel v-if="history && base" :history="history" :viewed-id="base.suiteId" />
    </template>
  </PageContainer>
</template>
