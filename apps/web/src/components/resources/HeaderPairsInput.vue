<script setup lang="ts">
import { ref } from 'vue';
import type { McpServerInput } from '@/api/types/resources';
import { headerPrefixOf, headerValueText } from './format';

type HeaderPair = McpServerInput['headers'][number];

/**
 * An http server's header names, each with the variable egress reads its value from and,
 * optionally, a fixed prefix egress writes before it (Phase 6 question 6):
 * "Authorization ← VENDOR_API_TOKEN", or 'Authorization ← "Bearer " + VENDOR_API_TOKEN', so
 * .env holds the raw token. Type the header name, the prefix if any, then the variable name;
 * Enter adds the pair (Enter in the header or prefix box moves on). Names only: a value is
 * never typed here; the prefix is not a secret.
 */
const props = withDefaults(
  defineProps<{ id?: string | null; invalid?: boolean; describedBy?: string | null }>(),
  { id: null, invalid: false, describedBy: null },
);
const model = defineModel<HeaderPair[]>({ required: true });

const header = ref('');
const prefix = ref('');
const env = ref('');
const prefixInput = ref<HTMLInputElement | null>(null);
const envInput = ref<HTMLInputElement | null>(null);

function add(): void {
  const h = header.value.trim();
  const e = env.value.trim().toUpperCase();
  if (!h || !e) return;
  const others = model.value.filter((p) => p.header.toLowerCase() !== h.toLowerCase());
  const p = headerPrefixOf(prefix.value);
  model.value = [...others, p ? { header: h, env: e, prefix: p } : { header: h, env: e }];
  header.value = '';
  prefix.value = '';
  env.value = '';
}
function onHeaderEnter(): void {
  if (env.value.trim()) add();
  else prefixInput.value?.focus();
}
function onPrefixEnter(): void {
  if (env.value.trim()) add();
  else envInput.value?.focus();
}
function remove(pair: HeaderPair): void {
  model.value = model.value.filter((p) => p !== pair);
}
</script>

<template>
  <div
    class="flex min-h-32 flex-wrap items-center gap-6 rounded-4 border bg-surface px-6 py-4 focus-within:border-accent"
    :class="props.invalid ? 'border-fail' : 'border-border-strong'"
    role="group"
    aria-label="Header names"
  >
    <span
      v-for="pair in model"
      :key="pair.header"
      class="inline-flex h-22 items-center gap-4 rounded-3 border border-border bg-surface-2 pr-4 pl-8 font-mono text-12"
      data-testid="chip"
      >{{ pair.header }} <span class="text-text-3">← {{ headerValueText(pair) }}</span
      ><button
        type="button"
        class="cursor-pointer border-0 bg-transparent px-2 text-text-3 hover:text-text"
        :aria-label="`Remove ${pair.header}`"
        @click="remove(pair)"
      >
        ×
      </button></span
    >
    <span class="inline-flex items-center gap-4">
      <input
        :id="id ?? undefined"
        v-model="header"
        class="w-160 min-w-0 border-0 bg-transparent font-mono text-12 outline-0"
        aria-label="Add header name"
        placeholder="e.g. Authorization"
        :aria-invalid="invalid ? 'true' : undefined"
        :aria-describedby="describedBy ?? undefined"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter.prevent="onHeaderEnter"
      />
      <span class="font-mono text-12 text-text-3" aria-hidden="true">←</span>
      <input
        ref="prefixInput"
        v-model="prefix"
        class="w-80 min-w-0 border-0 bg-transparent font-mono text-12 outline-0"
        aria-label="Prefix egress writes before the value (optional)"
        title='Optional, e.g. Bearer: egress sends "Bearer <value>"'
        placeholder="prefix"
        maxlength="64"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter.prevent="onPrefixEnter"
      />
      <input
        ref="envInput"
        v-model="env"
        class="w-160 min-w-0 border-0 bg-transparent font-mono text-12 outline-0"
        aria-label="Variable egress reads the value from"
        placeholder="VARIABLE_NAME"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter.prevent="add"
        @blur="add"
      />
    </span>
  </div>
</template>
