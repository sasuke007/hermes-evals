<script setup lang="ts">
import { computed } from 'vue';

/**
 * Sits above the content it concerns and never replaces it. Quotes the server message
 * verbatim in mono, because these users paste it into an issue.
 * Tones: error (orange, role=alert) · warning (amber) · info (accent) · violet (an execution
 * or scorer error: violet with a centre dot, role=alert).
 */
const props = withDefaults(
  defineProps<{
    tone?: 'error' | 'warning' | 'info' | 'violet';
    /** The human line, bold, in the tone's text colour. */
    title?: string | null;
    /** The verbatim server message. Mono for error and violet, plain text otherwise. */
    detail?: string | null;
    /** Overrides whether detail is set in mono. */
    mono?: boolean | null;
    /** The caption line: which service to check, when data was last good… */
    hint?: string | null;
    /** Shows a small button with this label that emits retry. */
    retryLabel?: string | null;
    /** 10px 12px padding instead of 12px 14px (inside a panel header). */
    compact?: boolean;
  }>(),
  {
    tone: 'error',
    title: null,
    detail: null,
    mono: null,
    hint: null,
    retryLabel: null,
    compact: false,
  },
);
defineEmits<{ retry: [] }>();

const role = computed(() =>
  props.tone === 'error' || props.tone === 'violet' ? 'alert' : 'status',
);
const detailMono = computed(
  () => props.mono ?? (props.tone === 'error' || props.tone === 'violet'),
);

/** Fill, border, and the ink of the icon and title, per tone. */
const TONES = {
  error: { box: 'border-fail bg-fail-soft', ink: 'text-fail-text', icon: 'text-fail-text' },
  violet: { box: 'border-err bg-err-soft', ink: 'text-err-text', icon: 'text-err-text' },
  warning: { box: 'border-ung bg-ung-soft', ink: 'text-ung-text', icon: 'text-ung-text' },
  info: { box: 'border-border-strong bg-accent-soft', ink: 'text-text', icon: 'text-accent' },
} as const;
const look = computed(() => TONES[props.tone]);
</script>

<template>
  <div
    class="flex items-start gap-12 rounded-6 border"
    :class="[look.box, compact ? 'px-12 py-10' : 'px-14 py-12']"
    :role="role"
    :data-tone="tone"
  >
    <svg
      class="mt-2 flex-none"
      :class="look.icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <template v-if="tone === 'warning'">
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
      </template>
      <template v-else-if="tone === 'info'">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M8 7.2v4M8 4.8h.01"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </template>
      <template v-else-if="tone === 'violet'">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <circle cx="8" cy="8" r="1.8" fill="currentColor" />
      </template>
      <template v-else>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M8 4.5v4M8 11h.01"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </template>
    </svg>
    <div
      class="flex min-w-0 flex-1 flex-col"
      :class="tone === 'warning' || tone === 'info' ? 'gap-2' : 'gap-4'"
    >
      <div
        v-if="title || $slots.title"
        class="font-semibold"
        :class="look.ink"
        data-testid="error-banner-title"
      >
        <slot name="title">{{ title }}</slot>
      </div>
      <slot>
        <code v-if="detail && detailMono" class="wrap-anywhere text-text-2">{{ detail }}</code>
        <div v-else-if="detail" class="text-text-2">{{ detail }}</div>
      </slot>
      <div v-if="hint || $slots.hint" class="text-12 text-text-3" data-testid="error-banner-hint">
        <slot name="hint">{{ hint }}</slot>
      </div>
    </div>
    <div v-if="retryLabel || $slots.actions" class="flex flex-none items-center gap-8">
      <slot name="actions" />
      <button v-if="retryLabel" type="button" class="btn sm" @click="$emit('retry')">
        {{ retryLabel }}
      </button>
    </div>
  </div>
</template>
