<script setup lang="ts">
import { computed, useId } from 'vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { SandboxStatus } from '@/api/types/system';

/**
 * The 15 isolation checks the worker runs before it executes anything. Collapsed to its
 * summary when all pass; failing checks are always listed with their detail, and an alert
 * above says execution is disabled and how to re-run the self-test.
 */
const props = withDefaults(
  defineProps<{
    status: SandboxStatus;
    /** Shows the "Execution is disabled" alert above the list when a check fails. */
    alert?: boolean;
  }>(),
  { alert: true },
);
/** Expanded state; defaults to expanded when a check fails. */
const expanded = defineModel<boolean | null>('expanded', { default: null });

const listId = `checks-${useId()}`;
const total = computed(() => props.status.checks.length);
const passed = computed(() => props.status.checks.filter((c) => c.passed).length);
const failed = computed(() => total.value - passed.value);
const isOpen = computed(() => expanded.value ?? failed.value > 0);

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
  <div class="scl">
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
      <div class="scl-head">
        <StatusChip kind="sandbox" :status="status.proven ? 'proven' : 'not_proven'" />
        <span class="scl-summary">{{ summary }}</span>
        <div class="scl-spacer" />
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
            :class="{ open: isOpen }"
            class="chev"
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
      <div class="t2 scl-meta">
        <span
          >Hermes <code class="scl-strong">{{ status.revision }}</code></span
        >
        <span
          >image <code class="scl-strong">{{ status.image }}</code></span
        >
        <span
          ><code class="scl-strong">{{ status.digest }}</code></span
        >
      </div>
      <ul :id="listId" class="scl-list" aria-label="Isolation checks">
        <template v-for="row in rows" :key="row.id">
          <li v-if="row.visible" class="chk" :class="{ bad: !row.passed }" :data-check="row.id">
            <span
              class="mark"
              :class="row.passed ? 'mark-pass' : 'mark-fail'"
              role="img"
              :aria-label="row.passed ? 'passed' : 'failed'"
              >{{ row.passed ? '✓' : '✕' }}</span
            >
            <div class="chk-body">
              <span class="chk-name"
                ><span class="mono t3 chk-n">{{ row.n }}</span
                >{{ ` ${row.name}` }}</span
              >
              <code class="t2 chk-detail">{{ row.detail }}</code>
            </div>
          </li>
        </template>
      </ul>
      <div v-if="!alert && failed > 0" class="t2 scl-hint">
        Hint: <code>{{ status.selftestCommand }}</code>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scl {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.scl-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.scl-summary {
  font-weight: 500;
}
.scl-spacer {
  flex: 1;
}
.chev {
  transition: transform 0.12s;
}
.chev.open {
  transform: rotate(90deg);
}
.scl-meta {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  font-size: 12px;
}
.scl-strong {
  color: var(--text);
}
.scl-list {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.chk.bad {
  background: var(--fail-soft);
}
.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
}
.mark-pass {
  background: var(--pass-soft);
  color: var(--pass-text);
}
.mark-fail {
  background: var(--fail-soft);
  color: var(--fail-text);
  box-shadow: inset 0 0 0 1px var(--fail);
}
.chk-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.chk-n {
  font-size: 11px;
  /* 6px in the design, made of a word space plus this margin. */
  margin-right: 3px;
}
.chk-detail {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.bad .chk-name {
  font-weight: 600;
  color: var(--fail-text);
}
.bad .chk-detail {
  color: var(--fail-text);
}
.scl-hint {
  padding: 8px 16px;
  font-size: 12px;
  border-top: 1px solid var(--border);
}
</style>
