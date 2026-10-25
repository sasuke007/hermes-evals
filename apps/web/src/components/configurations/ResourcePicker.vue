<script setup lang="ts">
import { ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { RouterLink } from 'vue-router';
import type { SelectOption } from '@/components/ui/types';

/**
 * A multi-select of resources (ConfigForm › Skills, Documents, MCP servers): each chosen one
 * as a chip with × to remove it, an "Add …" select that adds what is picked, and a link to
 * the resource library. The library opens in a new tab, so nothing typed here is lost; the
 * form reloads its options when the window regains focus.
 */
withDefaults(
  defineProps<{
    items: { id: string; label: string; detail?: string | null }[];
    options: SelectOption<string>[];
    /** "Add skill…", the select's first line. */
    placeholder: string;
    /** "Add skill", the select's accessible name. */
    addLabel: string;
    /** Shown in --text-3 when nothing is chosen ("None"); null shows nothing. */
    emptyText?: string | null;
    /** px. */
    selectWidth?: number;
    link?: { label: string; to: RouteLocationRaw } | null;
  }>(),
  { emptyText: 'None', selectWidth: 220, link: null },
);
const emit = defineEmits<{ add: [id: string]; remove: [id: string] }>();

const picked = ref('');

function onPick(): void {
  if (picked.value !== '') emit('add', picked.value);
  picked.value = '';
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-6">
    <span v-if="items.length === 0 && emptyText" class="text-text-3">{{ emptyText }}</span>
    <span
      v-for="item in items"
      :key="item.id"
      class="inline-flex h-28 items-center gap-6 rounded-4 border border-border-strong bg-surface-2 pr-4 pl-10 font-mono text-12"
      :data-item="item.id"
    >
      {{ item.label }}
      <span v-if="item.detail" class="text-text-3">{{ item.detail }}</span>
      <button
        type="button"
        class="size-20 rounded-3 border-0 bg-transparent text-text-3 hover:bg-surface-3 hover:text-text"
        :aria-label="`Remove ${item.label}`"
        :title="`Remove ${item.label}`"
        @click="emit('remove', item.id)"
      >
        ×
      </button>
    </span>
    <select
      v-model="picked"
      class="input h-28 text-12"
      :style="{ width: `${selectWidth}px` }"
      :aria-label="addLabel"
      :disabled="options.length === 0"
      @change="onPick"
    >
      <option value="">{{ placeholder }}</option>
      <option v-for="o in options" :key="o.value" :value="o.value" :disabled="o.disabled">
        {{ o.label }}
      </option>
    </select>
    <RouterLink v-if="link" :to="link.to" target="_blank" class="text-12">{{
      link.label
    }}</RouterLink>
  </div>
</template>
