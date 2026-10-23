<script setup lang="ts">
import { computed, useId } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import {
  useProvidersStore,
  type ConnectContext,
  type ConnectOrigin,
  type FollowUpAction,
} from '@/stores/providers';

/**
 * The one shared "you can't do this yet, and here is the fix" pattern. It wraps a disabled
 * control, keeps it in place, and renders the reason as visible amber text beside or under it,
 * ending with the link that fixes the cause. The control gets disabled, title and an
 * accessible description through the slot's `attrs`:
 *
 *   <BlockedReason :blocked="!providers.nousConnected" reason="Can't launch yet: Nous Portal is
 *     not connected." fix-label="Connect" connect-origin="new-experiment"
 *     @follow-up="onConnected" v-slot="{ attrs }">
 *     <button class="btn primary" v-bind="attrs">Launch 120 runs</button>
 *   </BlockedReason>
 */
const props = withDefaults(
  defineProps<{
    /** The full sentence: "Can't launch yet: Nous Portal is not connected." */
    reason: string;
    /** false renders the control enabled and no reason. */
    blocked?: boolean;
    /** "Connect", "Reconnect"… Omit for reasons the user cannot fix here. */
    fixLabel?: string | null;
    /** The fix is a route. */
    fixTo?: RouteLocationRaw | null;
    /** The fix opens ConnectDialog from this origin; its follow-up is re-emitted. */
    connectOrigin?: ConnectOrigin | null;
    connectContext?: ConnectContext;
    /** stacked: reason under a wide control (panels) · inline: beside a small one (toolbars). */
    layout?: 'stacked' | 'inline';
    /** stacked only: align the control and reason to the end (header actions). */
    align?: 'start' | 'end';
    /** warning: amber text · neutral: --text-3 for reasons the user cannot fix here. */
    tone?: 'warning' | 'neutral';
  }>(),
  {
    blocked: true,
    fixLabel: null,
    fixTo: null,
    connectOrigin: null,
    connectContext: () => ({}),
    layout: 'stacked',
    align: 'start',
    tone: 'warning',
  },
);
const emit = defineEmits<{ fix: []; 'follow-up': [action: FollowUpAction] }>();

const providers = useProvidersStore();
const reasonId = `blocked-${useId()}`;

const attrs = computed<Record<string, unknown>>(() =>
  props.blocked
    ? {
        disabled: true,
        title: props.reason,
        'aria-describedby': reasonId,
        'aria-description': props.reason,
      }
    : {},
);

function fix(): void {
  emit('fix');
  if (props.connectOrigin) {
    void providers.connect(
      props.connectOrigin,
      (action) => emit('follow-up', action),
      props.connectContext,
    );
  }
}
</script>

<template>
  <span class="blocked" :class="[`layout-${layout}`, `align-${align}`]">
    <slot :attrs="attrs" :blocked="blocked" />
    <span v-if="blocked" :id="reasonId" class="blocked-reason" :class="`tone-${tone}`">
      <slot name="reason">{{ reason }}</slot>
      <template v-if="fixLabel">
        {{ ' ' }}<RouterLink v-if="fixTo" :to="fixTo">{{ fixLabel }}</RouterLink
        ><button v-else type="button" class="linkbtn" @click="fix">{{ fixLabel }}</button>
      </template>
    </span>
  </span>
</template>

<style scoped>
.blocked {
  display: inline-flex;
  min-width: 0;
}
.layout-stacked {
  flex-direction: column;
  gap: 6px;
}
.layout-stacked.align-end {
  align-items: flex-end;
  text-align: right;
}
.layout-inline {
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.blocked-reason {
  font-size: 12px;
  line-height: 16px;
}
.blocked-reason.tone-warning {
  color: var(--ung-text);
}
.blocked-reason.tone-neutral {
  color: var(--text-3);
}
.blocked-reason .linkbtn {
  font-size: 12px;
}
</style>
