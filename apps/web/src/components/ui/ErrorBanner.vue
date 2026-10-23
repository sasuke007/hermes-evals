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

const role = computed(() => (props.tone === 'error' || props.tone === 'violet' ? 'alert' : 'status'));
const detailMono = computed(() => props.mono ?? (props.tone === 'error' || props.tone === 'violet'));
</script>

<template>
  <div class="eb" :class="[`eb-${tone}`, { compact }]" :role="role">
    <svg class="eb-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
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
    <div class="eb-body">
      <div v-if="title || $slots.title" class="eb-title">
        <slot name="title">{{ title }}</slot>
      </div>
      <slot>
        <code v-if="detail && detailMono" class="t2 eb-detail">{{ detail }}</code>
        <div v-else-if="detail" class="t2">{{ detail }}</div>
      </slot>
      <div v-if="hint || $slots.hint" class="cap">
        <slot name="hint">{{ hint }}</slot>
      </div>
    </div>
    <div v-if="retryLabel || $slots.actions" class="eb-actions">
      <slot name="actions" />
      <button v-if="retryLabel" type="button" class="btn sm" @click="$emit('retry')">
        {{ retryLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.eb {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: 6px;
  border: 1px solid var(--eb-border);
  background: var(--eb-bg);
}
.eb.compact {
  padding: 10px 12px;
}
.eb-error {
  --eb-bg: var(--fail-soft);
  --eb-border: var(--fail);
  --eb-ink: var(--fail-text);
}
.eb-violet {
  --eb-bg: var(--err-soft);
  --eb-border: var(--err);
  --eb-ink: var(--err-text);
}
.eb-warning {
  --eb-bg: var(--ung-soft);
  --eb-border: var(--ung);
  --eb-ink: var(--ung-text);
}
.eb-info {
  --eb-bg: var(--accent-soft);
  --eb-border: var(--border-strong);
  --eb-ink: var(--text);
}
.eb-icon {
  flex: none;
  margin-top: 2px;
  color: var(--eb-ink);
}
.eb-info .eb-icon {
  color: var(--accent);
}
.eb-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.eb-warning .eb-body,
.eb-info .eb-body {
  gap: 2px;
}
.eb-title {
  font-weight: 600;
  color: var(--eb-ink);
}
.eb-detail {
  overflow-wrap: anywhere;
}
.eb-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: none;
}
</style>
