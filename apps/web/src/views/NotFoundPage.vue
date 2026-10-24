<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
import { ROUTE_NAMES } from '@/router';

const route = useRoute();
</script>

<template>
  <main class="page">
    <h1 class="page-title">Page not found</h1>
    <p class="t2">
      Nothing lives at <code>{{ route.fullPath }}</code
      >. It may have been a link to an experiment or configuration that does not exist.
    </p>
    <p>
      <RouterLink :to="{ name: ROUTE_NAMES.experiments }" class="btn">Go to experiments</RouterLink>
    </p>
  </main>
</template>
