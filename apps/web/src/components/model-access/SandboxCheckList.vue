<script setup lang="ts">
import { computed, useId } from 'vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { SandboxStatus } from '@/api/types/system';
import { shortRevision } from '@/lib/format';

/**
 * The 15 isolation checks the worker runs before it executes anything. Collapsed to its
 * summary by default; failing checks are always listed with their detail ("Show all 15
 * checks" opens the rest, as the System board draws it), and an alert above says execution is
 * disabled and how to re-run the self-test.
 */
const props = withDefaults(
  defineProps<{
    status: SandboxStatus;
    /** Shows the "Execution is disabled" alert above the list when a check fails. */
    alert?: boolean;
  }>(),
  { alert: true },
);
/** Expanded state; collapsed by default (failing checks show either way). */
const expanded = defineModel<boolean | null>('expanded', { default: null });

const listId = `checks-${useId()}`;
const total = computed(() => props.status.checks.length);
const passed = computed(() => props.status.checks.filter((c) => c.passed).length);
const failed = computed(() => total.value - passed.value);
const isOpen = computed(() => expanded.value ?? false);
/** The Hermes revision as its first 7 characters; the full one is in the tooltip. */
const revision = computed(() => shortRevision(props.status.revision));
/** "sha256:7a6920…", as the System board draws it; the full digest is in the tooltip. */
const digest = computed(() =>
  props.status.digest.replace(/^(sha256:[0-9a-f]{6})[0-9a-f]{7,}$/, '$1…'),
);

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

const summary = computed(
  () =>
    `Isolation ${props.status.proven ? 'proven' : 'not proven'} · ${passed.value} of ${total.value} checks · checked ${ago(props.status.checkedAt)} at ${props.status.trigger}`,
);
const toggleLabel = computed(() => {
  if (isOpen.value) return 'Hide checks';
  return failed.value > 0 ? `Show all ${total.value} checks` : `Show ${total.value} checks`;
});
const rows = computed(() =>
  props.status.checks.map((check, i) => ({
    ...check,
    n: String(i + 1).padStart(2, '0'),
    visible: isOpen.value || !check.passed,
  })),
);

function toggle(): void {
  expanded.value = !isOpen.value;
}
</script>

<template>
  <div class="flex flex-col gap-8">
    <ErrorBanner v-if="alert && failed > 0" tone="error">
      <template #title
        >Execution is disabled: {{ failed }} of {{ total }} isolation checks failed. No run will
        start until every check passes.</template
      >
      <template #hint
        >Re-run the self-test after fixing the network:
        <code>{{ status.selftestCommand }}</code></template
      >
    </ErrorBanner>
    <div class="tbl">
      <div class="flex flex-wrap items-center gap-x-16 gap-y-8 border-b border-border px-16 py-12">
        <StatusChip kind="sandbox" :status="status.proven ? 'proven' : 'not_proven'" />
        <span class="font-medium" data-testid="sandbox-summary">{{ summary }}</span>
        <div class="flex-1" />
        <button
          type="button"
          class="btn ghost mid"
          :aria-expanded="isOpen ? 'true' : 'false'"
          :aria-controls="listId"
          @click="toggle"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            aria-hidden="true"
            class="transition-transform duration-[120ms]"
            :class="{ 'rotate-90': isOpen }"
          >
            <path
              d="M4 2.5L7.5 6 4 9.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
          {{ toggleLabel }}
        </button>
      </div>
      <div
        class="flex flex-wrap gap-x-18 gap-y-4 border-b border-border px-16 py-8 text-12 leading-20 text-text-2"
      >
        <span
          >Hermes <code class="text-text" :title="status.revision">{{ revision }}</code></span
        >
        <span
          >image <code class="text-text">{{ status.image }}</code></span
        >
        <span
          ><code class="text-text" :title="status.digest">{{ digest }}</code></span
        >
      </div>
      <ul :id="listId" class="flex flex-col" aria-label="Isolation checks">
        <template v-for="row in rows" :key="row.id">
          <li
            v-if="row.visible"
            class="grid grid-cols-[20px_minmax(0,1fr)] gap-8 border-b border-border px-16 py-8 last:border-b-0"
            :class="{ 'bg-fail-soft': !row.passed }"
            :data-check="row.id"
            :data-passed="row.passed ? 'true' : 'false'"
          >
            <span
              class="inline-flex size-18 items-center justify-center rounded-full text-11 font-bold"
              :class="
                row.passed
                  ? 'bg-pass-soft text-pass-text'
                  : 'bg-fail-soft text-fail-text inset-ring inset-ring-fail'
              "
              role="img"
              :aria-label="row.passed ? 'passed' : 'failed'"
              >{{ row.passed ? '✓' : '✕' }}</span
            >
            <div class="flex min-w-0 flex-col gap-2">
              <span :class="{ 'font-semibold text-fail-text': !row.passed }"
                ><span class="mr-3 font-mono text-11 text-text-3">{{ row.n }}</span
                >{{ ` ${row.name}` }}</span
              >
              <code
                class="text-12 wrap-anywhere"
                :class="row.passed ? 'text-text-2' : 'text-fail-text'"
                >{{ row.detail }}</code
              >
            </div>
          </li>
        </template>
      </ul>
      <div
        v-if="!alert && failed > 0"
        class="border-t border-border px-16 py-8 text-12 leading-20 text-text-2"
      >
        Hint: <code>{{ status.selftestCommand }}</code>
      </div>
    </div>
  </div>
</template>
