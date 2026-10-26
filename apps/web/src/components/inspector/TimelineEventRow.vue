<script setup lang="ts">
import { computed } from 'vue';
import type { TimelineEvent } from '@/api/types/runs';
import {
  EVENT_ICON,
  eventLook,
  formatAt,
  formatEventDuration,
  isCancelMarker,
  networkLine,
  outputNote,
} from './inspectorFormat';
import { isNeutralRow, rowTitle } from './neutralRows';

/**
 * One row of EventTimeline (RunInspector › Timeline; Components 2 › TimelineEventRow): the
 * time since the attempt started, the kind's mark, the tool (an MCP tool with its server
 * tag) or title and a one-line summary, an error flag and the duration. Expanding a tool call
 * shows its input and output verbatim; a text, network or platform row shows its text. A
 * connection the sandbox refused during the agent's call hangs under it as a red sub-row; a
 * request of Hermes's own in the background is a neutral row tagged "Hermes background",
 * refused or not, and an MCP server's 405 to the event-stream GET is a neutral "MCP event
 * stream not offered · vendor-directory · 405". A cancel ends the timeline as a dashed marker.
 */
const props = defineProps<{ event: TimelineEvent; open: boolean }>();
const emit = defineEmits<{ toggle: [] }>();

const look = computed(() => eventLook(props.event));
const network = computed(() => props.event.kind === 'network' || props.event.kind === 'refused');
const background = computed(() => props.event.origin === 'hermes-background');
const neutral = computed(() => isNeutralRow(props.event));
const title = computed(() => rowTitle(props.event));
const detailId = computed(() => `ri-event-${props.event.seq}`);
const wrapClass = computed(() => {
  if (props.event.running) return 'bg-run-soft';
  if (look.value === 'error') return 'bg-fail-soft';
  return network.value ? 'bg-surface-2' : '';
});

const CODE =
  'overflow-auto rounded-4 border bg-surface-2 px-12 py-10 font-mono text-12 leading-18 break-words whitespace-pre-wrap';
</script>

<template>
  <div
    class="flex flex-col"
    :class="wrapClass"
    :data-seq="event.seq"
    :data-look="look"
    data-testid="timeline-event"
  >
    <div
      v-if="isCancelMarker(event)"
      class="flex min-h-36 items-center gap-10 border-b border-border bg-surface-2 px-12"
      data-testid="cancel-marker"
    >
      <span class="w-56 flex-none font-mono text-11 text-text-3">{{ formatAt(event.atMs) }}</span>
      <span class="h-0 flex-1 border-t-2 border-dashed border-que" aria-hidden="true" />
      <span class="font-medium text-text-2">{{ event.summary }}</span>
      <span class="h-0 flex-1 border-t-2 border-dashed border-que" aria-hidden="true" />
    </div>
    <template v-else>
      <button
        type="button"
        class="grid min-h-36 w-full cursor-pointer grid-cols-[56px_20px_minmax(0,1fr)_72px_64px_20px] items-center gap-8 border-0 border-b border-border bg-transparent px-12 text-left hover:bg-surface-2"
        :aria-expanded="open"
        :aria-controls="open ? detailId : undefined"
        @click="emit('toggle')"
      >
        <span class="font-mono text-11 text-text-3">{{ formatAt(event.atMs) }}</span>
        <span class="inline-block flex-none" :class="EVENT_ICON[look]" aria-hidden="true" />
        <span class="flex min-w-0 items-center gap-8">
          <span v-if="event.server" class="tag border-accent text-accent">{{ event.server }}</span>
          <span
            class="font-mono text-12 whitespace-nowrap"
            :class="network ? 'font-normal text-text-2' : 'font-semibold'"
            data-testid="event-title"
            >{{ title }}</span
          >
          <span
            v-if="background"
            class="inline-flex h-18 items-center rounded-3 bg-surface-3 px-6 text-11 whitespace-nowrap text-text-2"
            >Hermes background</span
          >
          <span class="truncate font-mono text-12 text-text-2" data-testid="event-summary">{{
            event.summary
          }}</span>
        </span>
        <span class="text-12 font-semibold text-fail-text">{{
          event.error && !neutral ? 'error' : ''
        }}</span>
        <span
          class="text-right font-mono text-12"
          :class="event.running ? 'text-run-text' : 'text-text-2'"
          >{{ event.running ? 'running' : formatEventDuration(event.durationMs) }}</span
        >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          class="text-text-3 transition-transform"
          :class="{ 'rotate-90': open }"
        >
          <path
            d="M4 2.5L7.5 6 4 9.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <div
        v-if="event.kind === 'tool' && event.refusal"
        class="grid min-h-32 grid-cols-[56px_20px_minmax(0,1fr)] items-center gap-8 border-b border-border bg-surface-2 px-12 py-4"
        data-testid="refusal-row"
      >
        <span />
        <span
          class="inline-block size-14 rounded-full bg-[linear-gradient(135deg,transparent_45%,var(--fail)_45%_55%,transparent_55%)] inset-ring-[1.5px] inset-ring-fail"
          aria-hidden="true"
        />
        <span class="text-12 leading-18">
          <b class="text-fail-text">Refused by sandbox:</b>
          {{ ' ' }}<code class="font-mono">{{ event.refusal.host }}:{{ event.refusal.port }}</code
          >, <span class="text-text-2">{{ event.refusal.reason }}</span>
        </span>
      </div>
      <div
        v-if="open"
        :id="detailId"
        class="flex flex-col gap-10 border-b border-border bg-surface pt-12 pr-16 pb-16 pl-96 max-lg:pl-16"
        data-testid="event-detail"
      >
        <template v-if="event.kind === 'tool'">
          <div class="flex flex-col gap-4">
            <span class="text-12 text-text-3">Input</span>
            <pre :class="CODE">{{ event.input ?? '' }}</pre>
          </div>
          <div class="flex flex-col gap-4">
            <span class="text-12 text-text-3">{{ event.error ? 'Output · error' : 'Output' }}</span>
            <pre
              v-if="event.output !== null"
              :class="[CODE, event.error ? 'border-fail text-fail-text' : 'border-border']"
              >{{ event.output }}</pre>
            <span v-else class="text-12 text-text-3">
              {{ event.running ? 'No output yet: the call is still running.' : 'No output.' }}
            </span>
            <span v-if="outputNote(event)" class="text-12 text-text-3">{{
              outputNote(event)
            }}</span>
          </div>
        </template>
        <p v-else-if="network" class="leading-20 text-text-2">
          {{ event.text ?? networkLine(event) }}
        </p>
        <p v-else class="leading-20" :class="{ 'text-text-2': event.kind === 'platform' }">
          {{ event.text ?? event.summary }}
        </p>
      </div>
    </template>
  </div>
</template>
