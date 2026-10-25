<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { SecretExposure, SecretReference, SecretRow } from '@/api/types/resources';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import type { SkeletonColumn } from '@/components/ui/types';
import { formatDateTime } from '@/lib/format';
import { TONE_CLASSES } from '@/lib/statusTones';
import { ROUTE_NAMES } from '@/router';
import { secretKey, useResourcesStore } from '@/stores/resources';

/**
 * Resources › Secrets (ResourcesSecrets board): every name an MCP server references, whether
 * the service that reads it has it (the worker for a stdio server's variables, egress for an
 * http server's headers), and whether the agent can read the value. Never a value: there is
 * no field to type one. Beside the table, how to set one; "Check again" is in the page header.
 */
const store = useResourcesStore();
const secrets = computed(() => store.secrets);
const rows = computed(() => store.secretRows);

const SOURCE: Record<SecretRow['source'], string> = {
  worker: 'worker environment',
  egress: 'egress environment',
};
const EXPOSURE: Record<SecretExposure, string> = {
  readable_by_agent: 'Readable by the agent',
  egress_only: 'Added by egress · never in the run',
};
const SKELETON: SkeletonColumn[] = [
  { width: [130, 150] },
  { width: 40, height: 16 },
  { width: 120 },
  { width: [180, 220] },
  { width: [150, 210], height: 16 },
  { width: 140 },
];

const mcpLink = (ref: SecretReference) => ({
  name: ROUTE_NAMES.resourcesTab,
  params: { tab: 'mcp' },
  query: { mcp: ref.id },
});
const notSet = computed(() => rows.value.filter((r) => !r.set));
/** The name the instructions use: the first one not set, else the first one. */
const example = computed(() => notSet.value[0]?.name ?? rows.value[0]?.name ?? 'INVOICE_DB_URL');
/** References listed per name, then "and N more" (the names are in the title). */
const REFS_SHOWN = 2;
const shownRefs = (row: SecretRow) => row.referencedBy.slice(0, REFS_SHOWN);
const moreRefs = (row: SecretRow) => row.referencedBy.length - shownRefs(row).length;
const allRefs = (row: SecretRow) => row.referencedBy.map((r) => r.name).join('\n');
/** "invoice-db", "a or b", "a, b or c", "a, b, c and 4 more" for the not-set warning. */
function serverList(row: SecretRow): { names: string[]; more: number } {
  const names = [...new Set(row.referencedBy.map((r) => r.name))];
  return names.length > 3
    ? { names: names.slice(0, 3), more: names.length - 3 }
    : { names, more: 0 };
}
function joiner(i: number, list: { names: string[]; more: number }): string {
  if (i === 0) return '';
  if (i === list.names.length - 1 && list.more === 0) return ' or ';
  return ', ';
}
</script>

<template>
  <div class="flex flex-wrap items-start gap-16">
    <div class="flex min-w-0 flex-[999_1_640px] flex-col gap-8">
      <ErrorBanner
        v-if="secrets.error"
        title="Could not load secrets"
        :detail="secrets.error"
        retry-label="Retry"
        @retry="store.loadSecrets()"
      />
      <div
        v-if="secrets.loaded || secrets.loading"
        class="tbl"
        :class="{ 'opacity-55': !!secrets.error }"
      >
        <table
          class="dt loose"
          aria-label="Secrets"
          :aria-busy="secrets.loading && !secrets.loaded ? 'true' : undefined"
        >
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Source</th>
              <th>Referenced by</th>
              <th v-if="rows.length || !secrets.loaded">Exposure</th>
              <th>Last checked</th>
            </tr>
          </thead>
          <tbody v-if="!secrets.loaded">
            <SkeletonRows :columns="SKELETON" :rows="2" />
          </tbody>
          <tbody v-else-if="rows.length">
            <tr v-for="row in rows" :key="secretKey(row)" data-testid="secret-row">
              <td class="font-mono font-semibold">{{ row.name }}</td>
              <td><StatusChip kind="secret" :status="row.set ? 'set' : 'not_set'" /></td>
              <td class="font-mono text-12 whitespace-normal text-text-2">
                {{ SOURCE[row.source] }}
              </td>
              <td class="whitespace-normal">
                <div v-for="ref in shownRefs(row)" :key="ref.id" data-testid="secret-ref">
                  <RouterLink :to="mcpLink(ref)" class="font-mono text-12">{{
                    ref.name
                  }}</RouterLink
                  >{{ ' '
                  }}<span v-if="ref.via === 'env'" class="text-12 text-text-3"
                    >stdio MCP server · env</span
                  ><span v-else class="text-12 text-text-3"
                    >http MCP server · header <span class="font-mono">{{ ref.header }}</span></span
                  >
                </div>
                <div
                  v-if="moreRefs(row) > 0"
                  class="text-12 text-text-3"
                  :title="allRefs(row)"
                  data-testid="secret-ref-more"
                >
                  and {{ moreRefs(row) }} more
                </div>
              </td>
              <td>
                <span
                  class="chip"
                  :class="TONE_CLASSES[row.exposure === 'readable_by_agent' ? 'ung' : 'que'].chip"
                  :data-exposure="row.exposure"
                >
                  <StatusDot v-if="row.exposure === 'readable_by_agent'" tone="ung" mode="hollow" />
                  <svg v-else width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
                    <rect
                      x="3"
                      y="6.2"
                      width="8"
                      height="5.8"
                      rx="1"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    />
                    <path
                      d="M4.8 6.2V4.5a2.2 2.2 0 0 1 4.4 0v1.7"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    />
                  </svg>
                  {{ EXPOSURE[row.exposure] }}
                </span>
              </td>
              <td class="whitespace-normal text-text-2">
                {{ formatDateTime(row.lastCheckedAt) }}
                <span class="text-12 text-text-3">{{ row.checkedWhen }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div
          v-if="secrets.loaded && rows.length === 0"
          class="flex flex-col items-center gap-8 px-24 py-32 text-center"
          data-testid="empty-state"
        >
          <div class="text-15 font-semibold">No secrets referenced</div>
          <p class="max-w-440 text-text-2">
            A name appears here when an MCP server lists it as an environment variable or header.
            The app then shows whether it is set, never its value.
          </p>
          <RouterLink
            class="btn primary mt-4"
            :to="{ name: ROUTE_NAMES.resourcesTab, params: { tab: 'mcp' }, query: { mcp: 'new' } }"
            >Define MCP server</RouterLink
          >
        </div>
      </div>
      <p v-if="rows.length" class="text-12 text-text-3">
        One row per name referenced by an MCP server's environment variables or header names. The
        worker and egress report which names they have, never their values. There is no field to
        type a value anywhere in the app. Exposure says whether the agent can read the value:
        anything a stdio server can use, the agent can use too.
      </p>
      <div
        v-for="row in notSet"
        :key="secretKey(row)"
        class="flex items-start gap-10 rounded-6 border border-ung bg-ung-soft px-12 py-10"
        role="status"
        data-testid="not-set-warning"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
          class="mt-2 flex-none text-ung-text"
        >
          <path
            d="M8 1.8l6.5 11.4H1.5z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
          <path
            d="M8 6.2v3.2M8 11.4h.01"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <span class="text-text-2"
          ><b class="text-ung-text">{{ row.name }} is not set.</b> Runs of configurations that
          include
          <template v-for="(name, i) in serverList(row).names" :key="name"
            >{{ joiner(i, serverList(row)) }}<span class="font-mono">{{ name }}</span></template
          ><template v-if="serverList(row).more"
            >{{ ' ' }}and {{ serverList(row).more }} more</template
          >
          will fail at setup until it is.</span
        >
      </div>
    </div>

    <aside class="max-w-460 flex-[1_1_360px]" aria-labelledby="secrets-how">
      <section class="flex flex-col gap-12 rounded-6 border border-border bg-surface p-16">
        <h2 id="secrets-how" class="text-15 font-semibold">How to set a secret</h2>
        <ol class="flex list-decimal flex-col gap-12 pl-20">
          <li>
            <div class="flex flex-col gap-6">
              <span>Add the line to <code>.env</code> at the repository root:</span>
              <CodeBlock :code="`${example}=[YOUR VALUE]`" size="sm" />
            </div>
          </li>
          <li>
            <div class="flex flex-col gap-6">
              <span>Restart egress and the worker so they pick up the new environment:</span>
              <CodeBlock code="docker compose up -d egress worker" size="sm" />
            </div>
          </li>
          <li>
            Click <b>Check again</b>. The status changes to <b>set</b> once the worker reports the
            name.
          </li>
        </ol>
        <p class="text-12 leading-18 text-text-2">
          Values stay on your machine, in <code>.env</code>, and are never shown or stored here. How
          a value reaches a run depends on the server: a <b>stdio</b> server runs inside the run's
          container, so its environment variables are readable by the agent. Use scoped or throwaway
          values. An <b>http</b> server's headers are added by egress on the way to the server, so
          they never enter the run.
        </p>
        <p class="text-12 text-text-3">
          Launch records and logs never contain values; they show
          <code>&lt;from env {{ example }}&gt;</code>.
        </p>
      </section>
    </aside>
  </div>
</template>
