<script setup lang="ts">
/**
 * One row of the configuration form (ConfigForm board, `.row`): the field's name and help in
 * a 200px column, its controls beside it, 18px 20px padding, a border under every row but the
 * last. `for` labels a single control; a row of several controls names a group instead
 * (`labelId`, for the group's aria-labelledby). Below 768px the two columns stack.
 */
withDefaults(
  defineProps<{
    label: string;
    /** The id of the one control this row holds. */
    for?: string | null;
    /** The heading's id, when the controls are a group labelled by it. */
    labelId?: string | null;
    help?: string | null;
  }>(),
  { for: null, labelId: null, help: null },
);
</script>

<template>
  <div
    class="grid grid-cols-[200px_minmax(0,1fr)] gap-24 border-b border-border px-20 py-18 last:border-b-0 max-md:grid-cols-1 max-md:gap-8"
  >
    <div class="flex flex-col">
      <label v-if="$props.for" :for="$props.for" class="font-medium">{{ label }}</label>
      <span v-else :id="labelId ?? undefined" class="font-medium">{{ label }}</span>
      <p v-if="help || $slots.help" class="text-12 text-text-3">
        <slot name="help">{{ help }}</slot>
      </p>
    </div>
    <div class="min-w-0"><slot /></div>
  </div>
</template>
