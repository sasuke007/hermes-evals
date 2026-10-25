<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
import PageContainer from '@/components/layout/PageContainer.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import { ROUTE_NAMES } from '@/router';

const route = useRoute();
</script>

<template>
  <PageContainer>
    <PageHeader title="Page not found" />
    <p class="text-text-2">
      Nothing lives at <code>{{ route.fullPath }}</code
      >. It may have been a link to an experiment or configuration that does not exist.
    </p>
    <p>
      <RouterLink :to="{ name: ROUTE_NAMES.experiments }" class="btn">Go to experiments</RouterLink>
    </p>
  </PageContainer>
</template>
