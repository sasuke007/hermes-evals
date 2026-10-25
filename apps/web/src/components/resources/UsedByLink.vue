<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { ConfigurationLink } from '@/api/types/resources';
import { ROUTE_NAMES } from '@/router';
import { plural } from '@/lib/format';

/**
 * "Used by" in the resource tables: "1 configuration" links to that configuration, more
 * link to the configuration list (the names are in the title); none is "0 configurations"
 * (Skills board) or a bare "0" (`zero="number"`, MCP board), in --text-3.
 */
const props = withDefaults(
  defineProps<{ links: ConfigurationLink[]; zero?: 'words' | 'number' }>(),
  { zero: 'words' },
);

const text = computed(() => plural(props.links.length, 'configuration'));
const to = computed(() =>
  props.links.length === 1
    ? { name: ROUTE_NAMES.configuration, params: { id: props.links[0]!.configurationId } }
    : { name: ROUTE_NAMES.configurations },
);
const title = computed(() => props.links.map((l) => l.name).join(', '));
</script>

<template>
  <span v-if="links.length === 0" class="text-text-3" data-testid="used-by">{{
    zero === 'number' ? '0' : text
  }}</span>
  <RouterLink v-else :to="to" :title="title" data-testid="used-by">{{ text }}</RouterLink>
</template>
