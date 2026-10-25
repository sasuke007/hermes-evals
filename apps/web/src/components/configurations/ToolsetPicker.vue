<script setup lang="ts">
import { computed } from 'vue';
import ToggleButton from '@/components/ui/ToggleButton.vue';
import type { ToolsetOption } from '@/api/types/configurations';

/**
 * The toolsets a configuration turns on, as toggle chips in the runtime's order (ConfigForm ›
 * Toolsets: 17 chips loaded from the trial image, default on file and terminal). A toolset
 * the draft holds but the runtime no longer reports is kept at the end, so it can be turned
 * off.
 */
const props = defineProps<{
  options: ToolsetOption[];
  /** Id of the heading that names the group. */
  labelledby?: string;
}>();
const model = defineModel<string[]>({ required: true });

const names = computed(() => {
  const known = props.options.map((o) => o.name);
  return [...known, ...model.value.filter((t) => !known.includes(t))];
});

function set(name: string, on: boolean): void {
  model.value = on ? [...model.value, name] : model.value.filter((t) => t !== name);
}
</script>

<template>
  <div
    class="flex flex-wrap gap-6"
    role="group"
    :aria-label="labelledby ? undefined : 'Toolsets'"
    :aria-labelledby="labelledby"
    data-testid="toolsets"
  >
    <ToggleButton
      v-for="name in names"
      :key="name"
      variant="chip"
      :model-value="model.includes(name)"
      :data-toolset="name"
      @update:model-value="set(name, $event)"
      >{{ name }}</ToggleButton
    >
  </div>
</template>
