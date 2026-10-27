<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SystemSetup } from '@/api/types/system';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { SkeletonColumn } from '@/components/ui/types';
import SystemSection from './SystemSection.vue';
import {
  SEED_KIND_LABELS,
  SETUP_APPLY_COMMAND,
  judgeDetail,
  judgeSetting,
  judgeStatus,
  seedDetail,
} from './setupText';

/**
 * System › Judge and samples (Phase 8 G2, G3), from GET /system/setup: the LLM judge, with
 * whether it is the scripted mock model, and what this API start's samples seed created,
 * skipped or failed. The seed never stops the API: a seed that failed, or a sample it could
 * not add, is shown here with the reason. The samples are listed on demand, open from the
 * start when one failed.
 */
const props = withDefaults(
  defineProps<{
    setup: SystemSetup | null;
    error?: string | null;
  }>(),
  { error: null },
);
defineEmits<{ retry: [] }>();

const SKELETON: SkeletonColumn[] = [
  { width: 90 },
  { width: 150 },
  { width: 80, height: 16 },
  { width: ['70%', '55%'] },
];

const loading = computed(() => props.setup === null && !props.error);
const judge = computed(() => props.setup?.judge ?? null);
const seed = computed(() => props.setup?.seed ?? null);
const items = computed(() => seed.value?.items ?? []);
const anyFailed = computed(() => items.value.some((i) => i.outcome === 'failed'));

/** Null until the user toggles: then open when a sample failed. */
const toggled = ref<boolean | null>(null);
const open = computed(() => toggled.value ?? anyFailed.value);
</script>

<template>
  <SystemSection id="setup" title="Judge and samples" caption="read when the api starts">
    <ErrorBanner
      v-if="error"
      title="Could not load the judge and the samples"
      :detail="error"
      retry-label="Retry"
      @retry="$emit('retry')"
    />
    <div v-if="!(error && setup === null)" class="tbl" :aria-busy="loading ? 'true' : undefined">
      <table class="dt loose static" aria-labelledby="setup">
        <thead>
          <tr>
            <th class="w-150">Part</th>
            <th class="w-220">Setting</th>
            <th class="w-140">Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          <SkeletonRows v-if="loading" :columns="SKELETON" :rows="2" />
          <template v-else>
            <tr v-if="judge" data-setup="judge">
              <td class="font-semibold">LLM judge</td>
              <td class="font-mono text-12">{{ judgeSetting(judge) }}</td>
              <td><StatusChip kind="judge" :status="judgeStatus(judge)" /></td>
              <td class="text-text-2">
                {{ judgeDetail(judge) }}
                <template v-if="judge.mock || judge.mockModelName"
                  >Then run <code>{{ SETUP_APPLY_COMMAND }}</code
                  >.</template
                >
              </td>
            </tr>
            <tr v-if="seed" data-setup="seed">
              <td class="font-semibold">Samples</td>
              <td class="font-mono text-12">
                SEED_SAMPLES {{ seed.state === 'off' ? 'off' : 'on' }}
              </td>
              <td><StatusChip kind="seed" :status="seed.state" /></td>
              <td class="text-text-2">
                <div>{{ seedDetail(seed) }}</div>
                <code
                  v-if="seed.error"
                  class="block text-12 wrap-anywhere text-fail-text"
                  data-testid="seed-error"
                  >{{ seed.error }}</code
                >
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <template v-if="items.length">
      <button
        type="button"
        class="linkbtn self-start text-12"
        :aria-expanded="open ? 'true' : 'false'"
        aria-controls="setup-samples"
        data-testid="seed-items-toggle"
        @click="toggled = !open"
      >
        {{ open ? 'Hide the samples' : `Show the ${items.length} samples` }}
      </button>
      <div v-if="open" id="setup-samples" class="tbl">
        <table class="dt static" aria-label="Samples this start met">
          <thead>
            <tr>
              <th class="w-150">Kind</th>
              <th class="w-300">Name</th>
              <th class="w-140">Outcome</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in items"
              :key="`${item.kind}:${item.name}`"
              :data-seed-item="item.name"
            >
              <td class="text-text-2">{{ SEED_KIND_LABELS[item.kind] }}</td>
              <td class="font-mono text-12">{{ item.name }}</td>
              <td><StatusChip kind="seedItem" :status="item.outcome" size="sm" /></td>
              <td :class="item.outcome === 'failed' ? 'text-fail-text' : 'text-text-3'">
                {{ item.detail ?? '' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </SystemSection>
</template>
