<script setup lang="ts">
import CodeText from '@/components/authoring/editors/CodeText.vue';
import NoteIcon from '@/components/authoring/editors/NoteIcon.vue';

/**
 * A problem or a warning under the field that causes it (SA.5): violet with the dotted mark,
 * or amber, as the readiness issue says; role=alert so typing hears it.
 */
defineProps<{ message: string; severity: 'problem' | 'warning'; id?: string }>();
</script>

<template>
  <span
    :id="id"
    role="alert"
    class="flex items-start gap-6 text-12 leading-16"
    :class="severity === 'problem' ? 'text-err-text' : 'text-ung-text'"
    data-testid="field-message"
    ><NoteIcon :kind="severity" /><span><CodeText :text="message" /></span
  ></span>
</template>
