<script setup lang="ts">
import CodeText from '../editors/CodeText.vue';

/**
 * A labelled setting of a check card (SA.7, `.ck-field`): the label (with "optional"), the
 * control in the slot, a help line, and the problem the field has in violet ("Use a number
 * between 0 and 1.").
 */
withDefaults(
  defineProps<{
    label: string;
    help?: string | null;
    error?: string | null;
    optional?: boolean;
    /** The control's id, for <label for>. */
    for?: string | null;
    errorId?: string | null;
  }>(),
  { help: null, error: null, optional: false, for: null, errorId: null },
);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <label :for="$props.for ?? undefined" class="text-12 font-medium text-text-2"
      >{{ label }}<span v-if="optional" class="font-normal text-text-3"> optional</span></label
    >
    <slot />
    <span v-if="help" class="text-12 text-text-3"><CodeText :text="help" /></span>
    <span v-if="error" :id="errorId ?? undefined" role="alert" class="text-12 text-err-text"
      ><CodeText :text="error"
    /></span>
  </div>
</template>
