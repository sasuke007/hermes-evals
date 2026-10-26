<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { DraftSummary } from '@/api/types/authoring';
import BaseTooltip from '@/components/ui/BaseTooltip.vue';
import { draftLocation } from '@/views/suites/authoringRoutes';
import { draftChipText, draftTooltip } from './authoringFormat';

/**
 * The neutral chip beside a suite that has an open draft (SA.1): "draft · 3 changes",
 * linking to the draft, with "Draft based on v6, last edited 16:31" on hover and focus.
 */
defineProps<{ draft: DraftSummary }>();
</script>

<template>
  <BaseTooltip :text="draftTooltip(draft)" v-slot="{ describedBy }">
    <RouterLink
      :to="draftLocation(draft.folder)"
      class="chip bg-que-soft text-que-text no-underline hover:no-underline"
      :aria-describedby="describedBy"
      data-testid="draft-chip"
      >{{ draftChipText(draft) }}</RouterLink
    >
  </BaseTooltip>
</template>
