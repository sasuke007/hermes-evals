<script setup lang="ts">
/** The eye (seen by the agent) or the struck-through eye (hidden), as ZoneLabel draws them. */
defineProps<{ hidden?: boolean; size?: number }>();
</script>

<template>
  <svg
    :width="size ?? 14"
    :height="size ?? 14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.25"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="flex-none"
  >
    <template v-if="!hidden">
      <path
        d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
      />
      <circle cx="12" cy="12" r="3" />
    </template>
    <template v-else>
      <path
        d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"
      />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path
        d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"
      />
      <path d="m2 2 20 20" />
    </template>
  </svg>
</template>
