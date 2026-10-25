<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { errorMessage } from '@/api/client';
import type { SuiteHistoryEntry } from '@/api/types/suites';
import PageContainer from '@/components/layout/PageContainer.vue';
import ReloadFailedBanner from '@/components/suites/ReloadFailedBanner.vue';
import ReloadIcon from '@/components/suites/ReloadIcon.vue';
import SuiteHistoryPanel from '@/components/suites/SuiteHistoryPanel.vue';
import SuiteTaskTable from '@/components/suites/SuiteTaskTable.vue';
import SuiteVersionSelect from '@/components/suites/SuiteVersionSelect.vue';
import { reloadLine } from '@/components/suites/suiteFormat';
import BaseTag from '@/components/ui/BaseTag.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { formatDateTime, shortHash, plural } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useSuitesStore } from '@/stores/suites';

/**
 * One suite version (SuiteDetail, SuiteDetailStates boards; UI_FLOWS 8.2; Flow D step 3):
 * its tasks with validity, a failed self-check expanded in place, the version selector and
 * the History panel. An older version is read-only and says so, with the way back to the
 * current one; only the current version reloads from disk.
 */
const props = defineProps<{ suiteId: string }>();

const store = useSuitesStore();
const router = useRouter();

const error = ref<string | null>(null);
const historyError = ref<string | null>(null);
const table = ref<InstanceType<typeof SuiteTaskTable> | null>(null);
/** This page's last reload line ("Created v6 · 1 task now invalid: late_fees"). */
const reloadNote = ref<string | null>(null);

const suite = computed(() => store.suites[props.suiteId] ?? null);
const history = computed<SuiteHistoryEntry[] | null>(() => store.histories[props.suiteId] ?? null);
/** The name before the suite loads, from the list when it is known. */
const knownName = computed(
  () => suite.value?.name ?? store.list.find((r) => r.suiteId === props.suiteId)?.name ?? null,
);

async function load(force = false): Promise<void> {
  error.value = null;
  historyError.value = null;
  const id = props.suiteId;
  const [detail, versions] = await Promise.allSettled([
    store.loadSuite(id, force),
    store.loadHistory(id, force),
  ]);
  if (id !== props.suiteId) return;
  if (detail.status === 'rejected') error.value = errorMessage(detail.reason);
  if (versions.status === 'rejected') historyError.value = errorMessage(versions.reason);
}
// Every visit refetches (the kept record draws first): History's "Used by experiments" moves.
watch(
  () => props.suiteId,
  () => {
    reloadNote.value = null;
    void load(true);
  },
  { immediate: true },
);

const currentVersion = computed(() => suite.value?.versions.find((v) => v.current) ?? null);
const isOld = computed(() => !!suite.value && !suite.value.current);
const viewedLabel = computed(() => `v${suite.value?.versionNumber ?? ''}`);
const currentLabel = computed(() => `v${currentVersion.value?.versionNumber ?? ''}`);

/** Keys this version changed: its History row's changes, else its last load's. */
const changedKeys = computed(() => {
  const entry = history.value?.find((h) => h.suiteId === props.suiteId);
  if (entry) return entry.changes.changed;
  return suite.value?.current ? suite.value.lastLoad.changes.changed : [];
});

const invalidKeys = computed(
  () => suite.value?.tasks.filter((t) => !t.valid).map((t) => t.key) ?? [],
);
const alertTitle = computed(() => {
  const s = suite.value;
  if (!s) return '';
  const failed = `${plural(invalidKeys.value.length, 'task')} failed self-check`;
  const created =
    s.current &&
    s.lastLoad.outcome === 'created' &&
    invalidKeys.value.some((k) => s.lastLoad.changes.nowInvalid.includes(k));
  return created
    ? `Reload created v${s.versionNumber}: ${failed}`
    : `v${s.versionNumber}: ${failed}`;
});

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
  { label: 'Suites', to: { name: ROUTE_NAMES.suites } },
  { label: knownName.value ?? 'Suite' },
]);

const reloading = computed(() => !!suite.value && store.isReloading(suite.value.path));
const failedReload = computed(() => {
  const s = suite.value;
  return s?.current && s.lastLoad.outcome === 'error' && s.lastLoad.error ? s.lastLoad : null;
});

function openVersion(id: string): void {
  void router.push({ name: ROUTE_NAMES.suite, params: { id } });
}

async function reload(): Promise<void> {
  const s = suite.value;
  if (!s) return;
  const result = await store.reload(s.path);
  const entry = result?.suites.find((e) => e.sourcePath === s.path) ?? null;
  if (!entry) return;
  reloadNote.value = reloadLine(entry).text;
  if (entry.suiteId && entry.suiteId !== props.suiteId) {
    const note = reloadNote.value;
    await router.replace({ name: ROUTE_NAMES.suite, params: { id: entry.suiteId } });
    reloadNote.value = note;
    return;
  }
  await load(true);
}
</script>

<template>
  <PageContainer variant="detail">
    <template v-if="suite">
      <PageHeader :title="suite.name" :breadcrumbs="breadcrumbs" mono>
        <template #title-extra>
          <SuiteVersionSelect
            :versions="suite.versions"
            :viewed-id="suite.suiteId"
            @select="openVersion"
          />
          <span
            v-if="suite.versionLabel"
            class="text-text-3"
            title="Author label from suite.yaml"
            >{{ suite.versionLabel }}</span
          >
          <BaseTag :title="suite.contentHash">{{ shortHash(suite.contentHash) }}</BaseTag>
          <span class="text-text-2" data-testid="task-count"
            >{{ plural(suite.taskCount, 'task') }} · {{ suite.validCount }} valid</span
          >
        </template>
        <template #meta>
          <p class="text-12 text-text-3" data-testid="suite-strip">
            <code>{{ suite.path }}</code> ·
            <template v-if="isOld"
              >{{ viewedLabel }} · loaded {{ formatDateTime(suite.loadedAt) }} · versions don't
              change</template
            >
            <template v-else
              >{{ viewedLabel }} · loaded {{ formatDateTime(suite.loadedAt) }}</template
            >
            <span v-if="reloadNote" role="status"> · {{ reloadNote }}</span>
          </p>
        </template>
        <template #actions>
          <!-- Phase 5b adds "Add task", "Edit details" and "Download .zip" here. -->
          <button
            v-if="!isOld"
            type="button"
            class="btn"
            :disabled="store.busy"
            data-testid="reload-suite"
            @click="reload"
          >
            <ReloadIcon :spinning="reloading" />
            {{ reloading ? 'Reloading…' : 'Reload from disk' }}
          </button>
        </template>
      </PageHeader>

      <ErrorBanner
        v-if="error"
        :title="`Could not load ${suite.name}`"
        :detail="error"
        retry-label="Retry"
        @retry="load(true)"
      />

      <ErrorBanner
        v-if="store.reloadError && store.reloadErrorPath === suite.path"
        title="Could not reload this suite"
        :detail="store.reloadError"
        hint="Reloading runs in the worker: check that it is up (System, or docker compose ps worker)."
        :retry-label="store.busy ? null : 'Try again'"
        @retry="reload"
      />

      <ReloadFailedBanner
        v-if="failedReload"
        :name="suite.name"
        :error="failedReload.error!"
        :served-version="failedReload.servedVersion"
        :busy="store.busy"
        @retry="reload"
      />

      <div
        v-if="isOld"
        role="status"
        class="flex items-center gap-12 rounded-6 border border-border-strong bg-accent-soft px-14 py-10"
        data-testid="old-version"
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
            d="M8 4.5V8l2.2 1.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <span class="flex-1"
          ><b>You are viewing {{ viewedLabel }}. The current version is {{ currentLabel }}.</b>
          {{ ' ' }}
          <span class="text-text-2"
            >Tasks below are as saved in {{ viewedLabel }}. Versions don't change; to edit, go back
            to {{ currentLabel }}.</span
          ></span
        >
        <button
          v-if="currentVersion"
          type="button"
          class="btn sm"
          @click="openVersion(currentVersion.suiteId)"
        >
          Back to {{ currentLabel }}
        </button>
      </div>

      <div
        v-if="invalidKeys.length"
        role="alert"
        class="flex items-start gap-12 rounded-6 border border-fail bg-fail-soft px-14 py-12"
        data-testid="invalid-alert"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
          class="mt-2 flex-none text-fail-text"
        >
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path
            d="M8 4.5v4M8 11h.01"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <div class="flex flex-1 flex-col gap-2">
          <b class="text-fail-text">{{ alertTitle }}</b>
          <span v-if="invalidKeys.length === 1" class="text-text-2"
            ><span class="font-mono">{{ invalidKeys[0] }}</span> is shown in experiments but cannot
            be selected until its check passes on its own reference answer. Existing experiments
            keep the version they ran on.</span
          >
          <span v-else class="text-text-2"
            ><span class="font-mono">{{ invalidKeys.join(', ') }}</span> are shown in experiments
            but cannot be selected until their checks pass on their own reference answers. Existing
            experiments keep the version they ran on.</span
          >
        </div>
        <button type="button" class="btn sm" @click="table?.reveal(invalidKeys[0]!)">
          Show {{ invalidKeys[0] }}
        </button>
      </div>

      <SuiteTaskTable
        ref="table"
        :suite-id="suite.suiteId"
        :tasks="suite.tasks"
        :changed-keys="changedKeys"
      />

      <ErrorBanner
        v-if="historyError"
        title="Could not load the history"
        :detail="historyError"
        retry-label="Retry"
        @retry="load(true)"
      />
      <SuiteHistoryPanel v-else-if="history" :history="history" :viewed-id="suite.suiteId" />
    </template>

    <template v-else-if="error">
      <PageHeader :title="knownName ?? 'Suite'" :breadcrumbs="breadcrumbs" mono />
      <ErrorBanner
        :title="`Could not load ${knownName ?? 'this suite'}`"
        :detail="error"
        retry-label="Retry"
        @retry="load(true)"
      />
    </template>

    <template v-else>
      <div class="flex flex-col gap-4" aria-busy="true" data-testid="suite-loading">
        <span class="h-10 w-120 animate-shimmer rounded-3 bg-surface-3" aria-hidden="true" />
        <span class="mt-8 h-16 w-240 animate-shimmer rounded-3 bg-surface-3" aria-hidden="true" />
      </div>
      <SuiteTaskTable :suite-id="suiteId" :tasks="[]" loading />
    </template>
  </PageContainer>
</template>
