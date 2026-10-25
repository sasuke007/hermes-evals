<script setup lang="ts">
/** The circular arrow of the reload buttons (SuiteList, SuiteDetail); spins while busy. */
withDefaults(defineProps<{ spinning?: boolean }>(), { spinning: false });
</script>

<template>
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    aria-hidden="true"
    :class="{ 'animate-spin': spinning }"
    :data-spinning="spinning ? 'true' : undefined"
  >
    <path
      d="M11.5 7A4.5 4.5 0 1 1 9.8 3.5M11.5 2v3h-3"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
