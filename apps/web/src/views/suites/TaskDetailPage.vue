<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { errorMessage } from '@/api/client';
import type { TaskDiff, TaskVersionEntry } from '@/api/types/suites';
import PageContainer from '@/components/layout/PageContainer.vue';
import FixturesPanel from '@/components/suites/FixturesPanel.vue';
import HomeFilesPanel from '@/components/suites/HomeFilesPanel.vue';
import PromptView from '@/components/suites/PromptView.vue';
import ReferencePanel from '@/components/suites/ReferencePanel.vue';
import SelfCheckPanel from '@/components/suites/SelfCheckPanel.vue';
import { taskFolderOf } from '@/components/suites/suiteFormat';
import TaskDiffView from '@/components/suites/TaskDiffView.vue';
import TaskUsagePanel from '@/components/suites/TaskUsagePanel.vue';
import TaskVersionHistory from '@/components/suites/TaskVersionHistory.vue';
import VerificationPanel from '@/components/suites/VerificationPanel.vue';
import VerifierScriptPanel from '@/components/suites/VerifierScriptPanel.vue';
import ZoneLabel from '@/components/suites/ZoneLabel.vue';
import BasePanel from '@/components/ui/BasePanel.vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import CopyButton from '@/components/ui/CopyButton.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import KeyValueList from '@/components/ui/KeyValueList.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { urlOptional, useUrlState } from '@/composables/useUrlState';
import { ROUTE_NAMES } from '@/router';
import { taskKeyOf, useSuitesStore } from '@/stores/suites';

/**
 * One task version (TaskDetail, TaskDetailStates boards; UI_FLOWS 8.2; Flow D step 4): what
 * the agent sees (prompt, fixtures), what it never sees (checks, reference answer, verifier
 * script), the last self-check, limits, the task's versions and the experiments that ran
 * it. An older version says so, with the way back. With ?diff=<suite id> the page shows the
 * TaskDiff board instead: this version against the one in that suite version (against its
 * own suite version, the first version's files). A task with home files (Phase 6) adds its
 * home seeds after the fixtures and its expected_home files after the reference answer.
 */
const props = defineProps<{ suiteId: string; taskKey: string }>();

const store = useSuitesStore();
const { diff: against } = useUrlState({ diff: urlOptional() });

const error = ref<string | null>(null);
const historyError = ref<string | null>(null);
const diffError = ref<string | null>(null);
const diff = ref<TaskDiff | null>(null);

const task = computed(() => store.tasks[taskKeyOf(props.suiteId, props.taskKey)] ?? null);
const history = computed<TaskVersionEntry[] | null>(
  () => store.taskHistories[taskKeyOf(props.suiteId, props.taskKey)] ?? null,
);

async function load(force = false): Promise<void> {
  const { suiteId, taskKey } = props;
  error.value = null;
  historyError.value = null;
  const [detail, versions] = await Promise.allSettled([
    store.loadTask(suiteId, taskKey, force),
    store.loadTaskHistory(suiteId, taskKey, force),
  ]);
  if (suiteId !== props.suiteId || taskKey !== props.taskKey) return;
  if (detail.status === 'rejected') error.value = errorMessage(detail.reason);
  if (versions.status === 'rejected') historyError.value = errorMessage(versions.reason);
}

async function loadDiff(): Promise<void> {
  diff.value = null;
  diffError.value = null;
  const other = against.value;
  if (!other) return;
  try {
    const result = await store.loadDiff(props.suiteId, props.taskKey, other);
    if (other === against.value) diff.value = result;
  } catch (err) {
    diffError.value = errorMessage(err);
  }
}

// Every visit refetches: the kept record draws first, and the experiments that ran the task
// (their status, pass rate and count) come up to date.
watch(
  () => [props.suiteId, props.taskKey],
  () => void load(true),
  { immediate: true },
);
watch(
  () => [props.suiteId, props.taskKey, against.value],
  () => void loadDiff(),
  {
    immediate: true,
  },
);

const current = computed(() => history.value?.find((h) => h.current) ?? null);
const isOld = computed(
  () => !!task.value && !!current.value && current.value.version !== task.value.version,
);
/** "unchanged since suite v1", "changed in suite v5", "replaced by v2 in suite v5". */
const versionNote = computed(() => {
  const t = task.value;
  if (!t) return '';
  if (isOld.value) {
    const newer = [...(history.value ?? [])].reverse().find((h) => h.version > t.version);
    if (newer) return `replaced by v${newer.version} in suite v${newer.introducedInSuiteVersion}`;
  }
  return t.version === 1
    ? `unchanged since suite v${t.introducedInSuiteVersion}`
    : `changed in suite v${t.introducedInSuiteVersion}`;
});
/** Files this version changed against the one before it (for the fixtures' notes). */
const changedFiles = computed(
  () => history.value?.find((h) => h.version === task.value?.version)?.changedFiles ?? [],
);
const folder = computed(() => (task.value ? taskFolderOf(task.value.path) : ''));

const suiteTo = computed(() => ({
  name: ROUTE_NAMES.suite,
  params: { id: task.value?.suite.suiteId ?? props.suiteId },
}));
const taskTo = computed(() => ({
  name: ROUTE_NAMES.task,
  params: { id: props.suiteId, key: props.taskKey },
}));
const currentTo = computed(() =>
  current.value
    ? { name: ROUTE_NAMES.task, params: { id: current.value.suiteId, key: props.taskKey } }
    : taskTo.value,
);

/** The diff's last crumb and title: "v1 → v2" and "Diff of task v1 and v2", or "Files of task v1". */
const diffTitle = computed(() => {
  const d = diff.value;
  if (!d) return { crumb: 'diff', title: 'Diff' };
  if (d.from.suiteId === d.to.suiteId) {
    return { crumb: `v${d.to.taskVersion}`, title: `Files of task v${d.to.taskVersion}` };
  }
  return {
    crumb: `v${d.from.taskVersion} → v${d.to.taskVersion}`,
    title: `Diff of task v${d.from.taskVersion} and v${d.to.taskVersion}`,
  };
});
const diffLoadedAt = computed(
  () => history.value?.find((h) => h.version === diff.value?.to.taskVersion)?.loadedAt ?? null,
);

const breadcrumbs = computed<BreadcrumbItem[]>(() => {
  const items: BreadcrumbItem[] = [
    { label: 'Suites', to: { name: ROUTE_NAMES.suites } },
    { label: task.value?.suite.name ?? 'Suite', to: suiteTo.value },
  ];
  if (!against.value) return [...items, { label: props.taskKey }];
  return [...items, { label: props.taskKey, to: taskTo.value }, { label: diffTitle.value.crumb }];
});

const limits = computed(() => {
  const l = task.value?.limits;
  return [
    { key: 'turns', label: 'Max turns', value: l?.maxTurns ? String(l.maxTurns) : null },
    { key: 'budget', label: 'Time budget', value: l?.budgetS ? `${l.budgetS} s` : null },
    {
      key: 'toolsets',
      label: 'Toolsets needed',
      value: l?.toolsetsNeeded.length ? l.toolsetsNeeded.join(', ') : null,
      mono: true,
    },
  ];
});
</script>

<template>
  <PageContainer variant="detail">
    <!-- TaskDiff: this version against another (?diff=<suite id>). -->
    <template v-if="against">
      <PageHeader :title="taskKey" :breadcrumbs="breadcrumbs" mono>
        <template #title-extra
          ><span class="text-text-2">{{ diffTitle.title }}</span></template
        >
        <template #meta>
          <p class="text-12 text-text-3">
            Task versions come from saves and reloads<template v-if="task">
              · <code>{{ folder }}</code></template
            >
          </p>
        </template>
      </PageHeader>
      <ErrorBanner
        v-if="diffError"
        :title="`Could not load the diff of ${taskKey}`"
        :detail="diffError"
        retry-label="Retry"
        @retry="loadDiff"
      />
      <TaskDiffView
        v-else-if="diff"
        :diff="diff"
        :loaded-at="diffLoadedAt"
        :to-invalid="task ? !task.valid : false"
        :back="taskTo"
      />
      <div v-else class="rounded-6 border border-border bg-surface p-16" aria-busy="true">
        <SkeletonRows
          :columns="[{ width: ['40%', '90%', '80%', '60%'] }]"
          :rows="4"
          layout="lines"
        />
      </div>
    </template>

    <template v-else-if="task">
      <div class="flex flex-col gap-6">
        <PageHeader :title="task.key" :breadcrumbs="breadcrumbs" mono>
          <template #title-extra>
            <BaseTag strong data-testid="task-version">v{{ task.version }}</BaseTag>
            <span class="text-text-2" data-testid="version-note">{{ versionNote }}</span>
            <span class="text-text-3" aria-hidden="true">·</span>
            <span class="text-text-2">{{ task.summary }}</span>
          </template>
          <template #meta>
            <code class="text-text-3" :title="folder">{{ folder }}</code>
          </template>
          <template #actions>
            <!-- Phase 5b adds "Edit task" (primary) and "Duplicate" here. -->
            <CopyButton
              :text="folder"
              variant="button"
              button-text="Copy path"
              :label="`Copy path ${folder}`"
            />
          </template>
        </PageHeader>
        <div
          v-if="isOld && current"
          role="status"
          class="flex flex-wrap items-center gap-x-14 gap-y-10 rounded-6 border border-border-strong bg-accent-soft px-12 py-10"
          data-testid="old-task-version"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
            class="flex-none text-accent"
          >
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path
              d="M8 7.2v4M8 4.8h.01"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
          <span class="min-w-280 flex-1"
            ><b
              >You are viewing v{{ task.version }} of <code>{{ task.key }}</code
              >. The current version is v{{ current.version }}.</b
            >
            <span class="text-text-2"> Versions don't change.</span></span
          >
          <!-- Phase 5b adds "Restore this version into the draft" (primary) here. -->
          <RouterLink class="btn" :to="currentTo">Back to v{{ current.version }}</RouterLink>
        </div>
      </div>

      <ErrorBanner
        v-if="error"
        :title="`Could not load ${taskKey}`"
        :detail="error"
        retry-label="Retry"
        @retry="load(true)"
      />

      <div class="flex flex-wrap items-start gap-16">
        <div class="flex min-w-0 flex-[999_1_640px] flex-col gap-16">
          <BasePanel aria-labelledby="task-prompt">
            <template #header>
              <div
                class="flex items-center justify-between gap-10 border-b border-border px-16 py-12"
              >
                <span class="flex flex-wrap items-center gap-10">
                  <h2 id="task-prompt" class="text-15 font-semibold">Prompt</h2>
                  <ZoneLabel zone="visible" />
                  <span class="text-12 text-text-3"
                    >Sent as <code>task.txt</code> in the agent's home</span
                  >
                </span>
                <span class="font-mono text-12 text-text-3"
                  >{{ task.prompt.file }} · {{ task.prompt.characters }} characters</span
                >
              </div>
            </template>
            <div class="p-16"><PromptView :markdown="task.prompt.markdown" /></div>
          </BasePanel>
          <FixturesPanel
            :suite-id="suiteId"
            :task-key="task.key"
            :fixtures="task.fixtures"
            :version="task.version"
            :changed-files="changedFiles"
          />
          <HomeFilesPanel kind="home_seed" :files="task.homeFiles" />
          <VerificationPanel :verification="task.verification" />
          <ReferencePanel :reference="task.reference" />
          <HomeFilesPanel kind="expected_home" :files="task.homeFiles" />
          <VerifierScriptPanel :verifier="task.verifier" :failure="task.selfCheckFailure" />
        </div>

        <aside class="flex max-w-440 flex-[1_1_340px] flex-col gap-16">
          <SelfCheckPanel
            :self-check="task.selfCheck"
            :failure="task.selfCheckFailure"
            :task-key="task.key"
            :suite-to="suiteTo"
          />
          <BasePanel title="Limits">
            <div class="px-16 py-12">
              <KeyValueList :items="limits" :label-width="120" :row-gap="6" />
            </div>
          </BasePanel>
          <ErrorBanner
            v-if="historyError"
            title="Could not load the task's versions"
            :detail="historyError"
            retry-label="Retry"
            @retry="load(true)"
          />
          <TaskVersionHistory
            v-else-if="history"
            :history="history"
            :task-key="task.key"
            :viewing-version="task.version"
            :current-invalid="!task.valid && !isOld"
          />
          <TaskUsagePanel
            :experiments="task.experiments"
            :version="task.version"
            :versioned="(history?.length ?? 1) > 1"
          />
        </aside>
      </div>
    </template>

    <template v-else-if="error">
      <PageHeader :title="taskKey" :breadcrumbs="breadcrumbs" mono />
      <ErrorBanner
        :title="`Could not load ${taskKey}`"
        :detail="error"
        retry-label="Retry"
        @retry="load(true)"
      />
    </template>

    <template v-else>
      <div class="flex flex-col gap-6" aria-busy="true" data-testid="task-loading">
        <span class="h-10 w-200 animate-shimmer rounded-3 bg-surface-3" aria-hidden="true" />
        <span class="mt-8 h-16 w-320 animate-shimmer rounded-3 bg-surface-3" aria-hidden="true" />
      </div>
      <div class="flex flex-wrap items-start gap-16" aria-hidden="true">
        <div class="flex min-w-0 flex-[999_1_640px] flex-col gap-16">
          <div v-for="i in 3" :key="i" class="rounded-6 border border-border bg-surface p-16">
            <SkeletonRows
              :columns="[{ width: ['40%', '95%', '80%', '60%'] }]"
              :rows="4"
              layout="lines"
            />
          </div>
        </div>
        <div class="flex max-w-440 flex-[1_1_340px] flex-col gap-16">
          <div v-for="i in 2" :key="i" class="rounded-6 border border-border bg-surface p-16">
            <SkeletonRows :columns="[{ width: ['50%', '80%', '70%'] }]" :rows="3" layout="lines" />
          </div>
        </div>
      </div>
    </template>
  </PageContainer>
</template>
