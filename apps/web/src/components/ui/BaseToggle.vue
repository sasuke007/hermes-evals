<script setup lang="ts">
/**
 * An on/off switch (role="switch"): ConfigForm › Memory. A 36 × 20 track, --accent when on,
 * with its label beside it ("Memory enabled" / "Memory disabled" is the page's to word).
 */
withDefaults(
  defineProps<{
    label?: string | null;
    /** Accessible name when there is no visible label. */
    ariaLabel?: string | null;
    disabled?: boolean;
  }>(),
  { label: null, ariaLabel: null, disabled: false },
);
const model = defineModel<boolean>({ default: false });
</script>

<template>
  <label
    class="inline-flex items-center gap-10"
    :class="disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'"
  >
    <button
      type="button"
      role="switch"
      class="relative h-20 w-36 flex-none rounded-full border-0 p-0"
      :class="model ? 'bg-accent' : 'bg-border-strong'"
      :aria-checked="model ? 'true' : 'false'"
      :aria-label="label ? undefined : (ariaLabel ?? undefined)"
      :disabled="disabled"
      @click="model = !model"
    >
      <span
        class="absolute top-2 size-16 rounded-full bg-surface transition-[left] duration-[120ms]"
        :class="model ? 'left-18' : 'left-2'"
        aria-hidden="true"
      />
    </button>
    <span v-if="label || $slots.default" class="font-medium"
      ><slot>{{ label }}</slot></span
    >
  </label>
</template>
