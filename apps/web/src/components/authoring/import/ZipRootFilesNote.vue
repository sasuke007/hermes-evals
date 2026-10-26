<script setup lang="ts">
import type { SuiteZipRootFile } from '@/api/types/authoring';
import CodeText from '@/components/suites/CodeText.vue';
import { formatBytes } from '@/lib/format';
import { rootFilesSentence } from './zipFormat';

/**
 * The files at a zip's suite root other than suite.yaml (a README), which the import leaves
 * out (Phase 5b question 2, Phase 7): a draft holds task files only, so the dialog names
 * each one with its size before Import, rather than dropping it silently.
 */
defineProps<{ files: SuiteZipRootFile[] }>();
</script>

<template>
  <div
    role="note"
    aria-label="Files not imported"
    class="flex flex-col gap-6 rounded-4 border border-border bg-surface-2 px-12 py-10 text-12"
    data-testid="zip-root-files"
  >
    <span class="text-text-2"><CodeText :text="rootFilesSentence(files)" /></span>
    <ul class="flex flex-col gap-2" aria-label="Root files not imported">
      <li
        v-for="rootFile in files"
        :key="rootFile.path"
        class="flex items-center justify-between gap-12"
        data-testid="zip-root-file"
      >
        <code class="min-w-0 truncate" :title="rootFile.path">{{ rootFile.path }}</code>
        <span class="flex-none text-text-3">{{ formatBytes(rootFile.sizeBytes) }}</span>
      </li>
    </ul>
  </div>
</template>
