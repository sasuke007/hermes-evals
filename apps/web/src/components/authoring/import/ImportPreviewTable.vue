<script setup lang="ts">
import type { TaskImportPreview } from '@/api/types/authoring';
import ReadinessDot from '@/components/authoring/save/ReadinessDot.vue';
import CodeText from '@/components/suites/CodeText.vue';

/**
 * Step 4 of Import tasks (SA.9): one row per task the import adds, with its key, summary,
 * reference value and readiness. A row whose key cannot be a folder name or is taken gets
 * an input in place of the key and its problem under it; a fix is sent back with the
 * settings (`keyFixes`) and the preview is built again.
 */
defineProps<{ preview: TaskImportPreview }>();
const emit = defineEmits<{ fix: [row: number, key: string] }>();

const WORD = { ready: 'ready', warnings: 'warnings', problems: 'problems', not_run: 'not run' };
const TONE = {
  ready: 'text-pass-text',
  warnings: 'text-ung-text',
  problems: 'text-err-text',
  not_run: 'text-que-text',
};
</script>

<template>
  <div class="overflow-hidden rounded-6 border border-border bg-surface">
    <table class="dt static" aria-label="Tasks to add" data-testid="import-preview">
      <thead>
        <tr>
          <th scope="col" class="w-40">Row</th>
          <th scope="col" class="w-280">Task key</th>
          <th scope="col">Summary</th>
          <th scope="col" class="w-120 text-right">Reference value</th>
          <th scope="col" class="w-120">Readiness</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in preview.rows"
          :key="row.row"
          :class="{ '[&>td]:bg-err-soft': row.needsFix }"
          :data-row="row.row"
        >
          <td class="font-mono text-text-3">{{ row.row }}</td>
          <td>
            <div v-if="row.needsFix" class="flex flex-col gap-4 py-6">
              <input
                class="input h-28 w-220 border-[1.5px] border-err font-mono text-12"
                :value="row.key"
                :aria-label="`Task key for row ${row.row}`"
                aria-invalid="true"
                spellcheck="false"
                data-testid="key-fix"
                @change="emit('fix', row.row, ($event.target as HTMLInputElement).value.trim())"
              />
              <span
                v-for="problem in row.problems.filter((p) => p.field === 'key')"
                :key="problem.message"
                class="text-12 leading-16 whitespace-normal text-err-text"
                ><CodeText :text="problem.message"
              /></span>
            </div>
            <span v-else class="font-mono font-semibold">{{ row.key }}</span>
          </td>
          <td class="whitespace-normal text-text-2">{{ row.summary }}</td>
          <td class="text-right font-mono">{{ row.referenceValue }}</td>
          <td>
            <span class="inline-flex items-center gap-6">
              <ReadinessDot :readiness="row.readiness" />
              <span class="text-12" :class="TONE[row.readiness]">{{ WORD[row.readiness] }}</span>
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
