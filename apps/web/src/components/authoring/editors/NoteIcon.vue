<script setup lang="ts">
/**
 * The 14px marks of the editor's notes (SA.4 to SA.6): `problem` the violet dotted ring,
 * `warning` the amber triangle, `info` the neutral ring with an i, `ok` the green check.
 */
defineProps<{ kind: 'problem' | 'warning' | 'info' | 'ok' }>();
</script>

<template>
  <span
    v-if="kind === 'problem'"
    class="mt-2 inline-block size-12 flex-none rounded-full border-2 border-dotted border-err bg-err-soft"
    aria-hidden="true"
  />
  <svg
    v-else
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.25"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="mt-2 flex-none"
    :class="kind === 'warning' ? 'text-ung-text' : kind === 'ok' ? 'text-pass' : 'text-text-3'"
  >
    <template v-if="kind === 'warning'">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </template>
    <path v-else-if="kind === 'ok'" d="M20 6 9 17l-5-5" />
    <template v-else>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </template>
  </svg>
</template>
