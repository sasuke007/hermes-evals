<script setup lang="ts">
/**
 * A pressable button (aria-pressed) that turns a filter or an option on and off:
 *   filter  30px, square corners: Runs › "Has execution error", "Ungradable"
 *   chip    28px pill in mono: ConfigForm › Toolsets
 * Pressed draws --accent-soft with an --accent border. Group several in a role="group".
 */
withDefaults(defineProps<{ variant?: 'filter' | 'chip'; disabled?: boolean }>(), {
  variant: 'filter',
  disabled: false,
});
const pressed = defineModel<boolean>({ default: false });
</script>

<template>
  <button
    type="button"
    class="inline-flex items-center gap-6 border border-border-strong bg-surface px-10 text-12 text-text-2 aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-text disabled:cursor-not-allowed disabled:opacity-45"
    :class="
      variant === 'chip'
        ? 'h-28 rounded-full font-mono aria-pressed:font-semibold'
        : 'h-30 rounded-4 font-medium'
    "
    :aria-pressed="pressed ? 'true' : 'false'"
    :disabled="disabled"
    @click="pressed = !pressed"
  >
    <slot />
  </button>
</template>
