<script setup lang="ts">
import { useRouter } from 'vue-router';
import BasePanel from '@/components/ui/BasePanel.vue';
import type { ConfigurationVersion } from '@/api/types/configurations';
import { formatDateTime } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';

/**
 * Every version of a configuration, newest first (ConfigDetail › Version history). Selecting
 * a version shows its fields as frozen (?version=<n>; the latest drops the parameter); the
 * version shown is tinted.
 */
const props = defineProps<{
  configurationId: string;
  versions: ConfigurationVersion[];
  /** The version the page shows. */
  shown: number;
}>();
const router = useRouter();

function select(v: ConfigurationVersion): void {
  if (v.version === props.shown) return;
  void router.push({
    name: ROUTE_NAMES.configuration,
    params: { id: props.configurationId },
    query: v.latest ? {} : { version: String(v.version) },
  });
}
</script>

<template>
  <BasePanel title="Version history" clip>
    <div class="overflow-x-auto">
      <table class="dt h38 clickable" aria-label="Version history">
        <thead>
          <tr>
            <th>Version</th>
            <th>Created</th>
            <th>Change</th>
            <th class="text-right">Experiments</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="v in versions"
            :key="v.versionId"
            :class="{ '[&>td]:bg-accent-soft': v.version === shown }"
            :aria-current="v.version === shown ? 'true' : undefined"
            :data-version="v.version"
            tabindex="0"
            @click="select(v)"
            @keydown.enter="select(v)"
          >
            <td>
              <span class="font-mono font-semibold">v{{ v.version }}</span>
              <template v-if="v.latest"
                >{{ ' ' }}<span class="chip bg-surface-3 text-text">latest</span></template
              >
            </td>
            <td class="text-text-2">{{ formatDateTime(v.createdAt) }}</td>
            <td class="whitespace-normal text-text-2">{{ v.change }}</td>
            <td class="text-right">{{ v.experimentCount }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="border-t border-border px-16 py-10 text-12 text-text-3">
      Selecting a version shows its fields as frozen. Experiments link here with "view as of this
      experiment", which opens that version.
    </p>
  </BasePanel>
</template>
