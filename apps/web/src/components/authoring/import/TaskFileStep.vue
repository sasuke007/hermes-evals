<script setup lang="ts">
import { ref } from 'vue';
import type { TaskTableFile } from '@/api/types/authoring';
import type { UploadProblem } from '@/api/types/resources';
import CodeText from '@/components/suites/CodeText.vue';
import { formatBytes } from '@/lib/format';

/**
 * Step 1 of Import tasks (SA.9): a .csv or .jsonl file dropped or chosen, the file as the API
 * read it (rows, columns, size), and the files it refused, each with why ("questions.xlsx:
 * use CSV or JSONL."). A refused file is not read; the last file read stays.
 */
defineProps<{
  file: TaskTableFile | null;
  rejected: { name: string; problems: UploadProblem[] }[];
  reading: boolean;
}>();
const emit = defineEmits<{ pick: [file: File] }>();

const input = ref<HTMLInputElement | null>(null);
const over = ref(false);

function onChange(event: Event): void {
  const target = event.target as HTMLInputElement;
  const picked = target.files?.[0];
  if (picked) emit('pick', picked);
  target.value = '';
}
function onDrop(event: DragEvent): void {
  over.value = false;
  const picked = event.dataTransfer?.files?.[0];
  if (picked) emit('pick', picked);
}
</script>

<template>
  <div class="flex flex-col gap-16">
    <div
      class="flex h-88 flex-col items-center justify-center gap-4 rounded-6 border border-dashed"
      :class="over ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface'"
      data-testid="task-file-drop"
      @dragenter.prevent="over = true"
      @dragover.prevent="over = true"
      @dragleave="over = false"
      @drop.prevent="onDrop"
    >
      <span
        >Drop a <code>.csv</code> or <code>.jsonl</code> file, or
        <button type="button" class="linkbtn" @click="input?.click()">browse</button></span
      >
      <span class="text-12 text-text-3"
        >Up to 5 MB and 500 rows. For JSONL, each object's keys become columns.</span
      >
      <input
        ref="input"
        type="file"
        accept=".csv,.jsonl,text/csv,application/jsonl"
        class="hidden"
        data-testid="task-file-input"
        @change="onChange"
      />
    </div>
    <div v-if="reading" role="status" class="flex items-center gap-8 text-text-2">
      <span
        class="size-12 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
        aria-hidden="true"
      />
      Reading the file. Nothing is added yet.
    </div>
    <div v-if="file" class="overflow-hidden rounded-6 border border-border bg-surface">
      <table class="dt static" aria-label="File read">
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Rows</th>
            <th scope="col">Columns</th>
            <th scope="col" class="text-right">Size</th>
            <th scope="col"><span class="sr-only">State</span></th>
          </tr>
        </thead>
        <tbody>
          <tr data-testid="task-file">
            <td class="font-mono font-semibold">{{ file.fileName }}</td>
            <td>{{ file.rowCount }}</td>
            <td class="font-mono text-12 text-text-2">
              {{ file.columns.map((c) => c.name).join(', ') }}
            </td>
            <td class="text-right font-mono text-12">{{ formatBytes(file.sizeBytes) }}</td>
            <td class="text-right">
              <span class="chip bg-pass-soft text-pass-text">read</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="rejected.length" class="flex flex-col gap-6" data-testid="task-file-rejected">
      <span class="text-12 font-semibold text-text-2">Rejected files are not read</span>
      <template v-for="r in rejected" :key="r.name">
        <div
          v-for="problem in r.problems"
          :key="problem.title"
          role="alert"
          class="flex items-start gap-8 rounded-4 border border-fail bg-fail-soft px-10 py-8"
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
          <span
            ><CodeText :text="problem.title" /><template v-if="problem.detail">
              <span class="text-text-2"> <CodeText :text="problem.detail" /></span></template
          ></span>
        </div>
      </template>
    </div>
  </div>
</template>
