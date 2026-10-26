<script setup lang="ts">
import type { SuiteZipScript, SuiteZipValidation } from '@/api/types/authoring';
import CodeText from '@/components/suites/CodeText.vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import { formatBytes, shortHash } from '@/lib/format';
import { scriptsCountLine, scriptsSentence } from './zipFormat';

/**
 * "This suite contains code" (SA.10, R7): every file a zip carries under a task's
 * `verify/`, each with its path, size and short hash, the ones a check runs marked "run by
 * a check" and counted apart (Phase 5b question 12: data such as `expected_stock.json` is
 * listed too), and the "I trust these scripts" tick that Import waits for. Scripts are the
 * only code that can arrive through the browser.
 */
defineProps<{ scripts: SuiteZipScript[]; counts: SuiteZipValidation['verifyCounts'] }>();
const trusted = defineModel<boolean>('trusted', { default: false });
</script>

<template>
  <div
    role="note"
    aria-label="This suite contains code"
    class="flex flex-col gap-8 rounded-6 border border-ung bg-ung-soft p-12"
    data-testid="zip-scripts"
  >
    <div class="flex items-start gap-8">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
        class="mt-2 flex-none text-ung-text"
      >
        <path
          d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <div class="flex flex-col gap-2">
        <b class="text-ung-text">This suite contains code</b>
        <span class="text-12 font-medium text-text" data-testid="zip-script-counts"
          ><CodeText :text="scriptsCountLine(counts)"
        /></span>
        <span class="text-12 leading-18 text-text-2">{{ scriptsSentence(counts) }}</span>
      </div>
    </div>
    <ul
      class="flex flex-col rounded-4 border border-border bg-surface"
      aria-label="Verifier scripts"
    >
      <li
        v-for="script in scripts"
        :key="script.path"
        class="grid grid-cols-[minmax(0,1fr)_96px_60px_72px] items-center gap-10 border-b border-border px-10 py-6 last:border-b-0"
        :data-run-by-check="script.runByCheck ? 'true' : 'false'"
        data-testid="zip-script"
      >
        <code class="truncate" :title="script.path">{{ script.path }}</code>
        <span class="text-12" :class="script.runByCheck ? 'text-ung-text' : 'text-text-3'">{{
          script.runByCheck ? 'run by a check' : 'file'
        }}</span>
        <span class="text-right text-12 text-text-3">{{ formatBytes(script.sizeBytes) }}</span>
        <BaseTag :title="script.sha256">{{ shortHash(script.sha256) }}</BaseTag>
      </li>
    </ul>
    <label class="flex cursor-pointer items-center gap-8 font-medium">
      <input
        v-model="trusted"
        type="checkbox"
        aria-describedby="zip-trust-help"
        data-testid="trust-scripts"
      />
      I trust these scripts
    </label>
    <span id="zip-trust-help" class="text-12 text-text-3"
      >Verifier scripts are Python. Importing is the only way code arrives through the
      browser.</span
    >
  </div>
</template>
