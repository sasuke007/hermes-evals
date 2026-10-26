<script setup lang="ts">
import { computed } from 'vue';
import type { TaskImportColumnUse, TaskTableColumn } from '@/api/types/authoring';
import ZoneLabel from '@/components/suites/ZoneLabel.vue';
import { MISSING } from '@/lib/format';
import {
  hasKeyColumn,
  mappingMessages,
  USE_OPTIONS,
  zoneOf,
  type ColumnMapping,
} from './columnMapping';

/**
 * What each column of an imported file becomes (ColumnMapper component, SA.9 step 2): one
 * row per column with its first values, a "Use as" select and where the values go (the
 * prompt to the agent, the reference to the hidden checks, the key and summary to the
 * platform). With no Task key column a key prefix generates the keys; what the mapping
 * lacks is listed under it, and a column at fault has its select outlined.
 */
const props = defineProps<{ columns: TaskTableColumn[] }>();
const mapping = defineModel<ColumnMapping[]>('mapping', { required: true });
const keyPrefix = defineModel<string>('keyPrefix', { default: '' });

const useOf = (column: string): TaskImportColumnUse =>
  mapping.value.find((m) => m.column === column)?.use ?? 'ignore';

function setUse(column: string, use: TaskImportColumnUse): void {
  const others = mapping.value.filter((m) => m.column !== column);
  const next = props.columns.map((c) =>
    c.name === column
      ? { column, use }
      : (others.find((m) => m.column === c.name) ?? { column: c.name, use: 'ignore' as const }),
  );
  mapping.value = next;
}

const messages = computed(() => mappingMessages(mapping.value));
const faulty = computed(() => new Set(messages.value.map((m) => m.column).filter(Boolean)));
const showPrefix = computed(() => !hasKeyColumn(mapping.value));
const prefixExample = computed(() => {
  const prefix = keyPrefix.value || 'task_';
  return [`${prefix}01`, `${prefix}02`];
});
</script>

<template>
  <div class="flex flex-col gap-10" data-testid="column-mapper">
    <div class="overflow-hidden rounded-6 border border-border bg-surface">
      <table class="dt static" aria-label="Columns of the file">
        <thead>
          <tr>
            <th scope="col" class="w-150">Column in the file</th>
            <th scope="col">Sample values</th>
            <th scope="col" class="w-270">Use as</th>
            <th scope="col" class="w-220">Goes to</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="column in columns"
            :key="column.name"
            :class="{ 'text-text-3': useOf(column.name) === 'ignore' }"
            :data-column="column.name"
          >
            <td class="font-mono font-semibold">{{ column.name }}</td>
            <td>
              <div class="flex flex-col gap-2 py-6">
                <span
                  v-for="(value, i) in column.samples"
                  :key="i"
                  class="max-w-420 truncate font-mono text-12 text-text-2"
                  :title="value"
                  >{{ value }}</span
                >
              </div>
            </td>
            <td>
              <select
                class="input sm min-w-250 text-12"
                :aria-label="`Use ${column.name} as`"
                :aria-invalid="faulty.has(column.name) ? 'true' : 'false'"
                :value="useOf(column.name)"
                data-testid="column-use"
                @change="
                  setUse(
                    column.name,
                    ($event.target as HTMLSelectElement).value as TaskImportColumnUse,
                  )
                "
              >
                <option v-for="option in USE_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </td>
            <td>
              <ZoneLabel
                v-if="zoneOf(useOf(column.name)) === 'visible'"
                zone="visible"
                label="Agent sees · prompt.md"
              />
              <ZoneLabel
                v-else-if="zoneOf(useOf(column.name)) === 'hidden'"
                zone="hidden"
                label="Hidden · checks only"
              />
              <span
                v-else-if="zoneOf(useOf(column.name)) === 'metadata'"
                class="text-12 text-text-3"
                >Platform metadata</span
              >
              <span v-else class="text-text-3">{{ MISSING }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      v-if="showPrefix"
      class="flex flex-wrap items-center gap-x-16 gap-y-8 rounded-6 border border-border bg-surface px-14 py-12"
      data-testid="key-prefix"
    >
      <label for="import-key-prefix" class="text-12 font-medium text-text-2">Key prefix</label>
      <input
        id="import-key-prefix"
        v-model="keyPrefix"
        class="input w-200 font-mono text-12"
        spellcheck="false"
      />
      <span class="text-12 text-text-3"
        >No column is mapped to Task key, so keys are generated: <code>{{ prefixExample[0] }}</code
        >, <code>{{ prefixExample[1] }}</code
        >, …</span
      >
    </div>
    <div class="flex flex-col gap-4" data-testid="mapping-messages">
      <span
        v-for="m in messages"
        :key="m.message"
        class="text-12 leading-18"
        :class="m.severity === 'problem' ? 'text-fail-text' : 'text-text-3'"
        :role="m.severity === 'problem' ? 'alert' : undefined"
        :data-severity="m.severity"
        >{{ m.message }}</span
      >
    </div>
  </div>
</template>
