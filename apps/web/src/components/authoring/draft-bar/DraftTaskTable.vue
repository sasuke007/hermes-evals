<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { DraftTaskRow } from '@/api/types/authoring';
import { READINESS_WORDS, changeText, versionText } from './draftText';

/**
 * The task table in draft mode (SA.3): drag handles (the order is written to suite.yaml), a
 * change column and a readiness column (ready · warnings · problems · self-check not run)
 * before the task, its version on save ("v2 → v3 on save"), summary, checks and fixtures.
 * A removed task stays, struck through, with Undo and what the save does to its folder.
 * Rows reorder by dragging, or with the arrow keys on the handle.
 */
const props = withDefaults(
  defineProps<{
    rows: DraftTaskRow[];
    /** `./suites/invoices-v1`, for "Removes ./suites/invoices-v1/currency_mix/ when you save". */
    path: string;
    baseVersion: number | null;
    editTo: (key: string) => RouteLocationRaw;
    readonly?: boolean;
  }>(),
  { readonly: false },
);
const emit = defineEmits<{
  reorder: [order: string[]];
  duplicate: [key: string];
  remove: [key: string];
  undo: [key: string];
}>();

const menu = ref<string | null>(null);
const confirming = ref<string | null>(null);
const dragging = ref<string | null>(null);

const CHANGE_TONE: Record<string, string> = {
  added: 'border-transparent bg-pass-soft text-pass-text',
  changed: 'border-transparent bg-run-soft text-run-text',
  restored: 'border-transparent bg-run-soft text-run-text',
  removed: 'border-transparent bg-que-soft text-que-text',
};
const DOT: Record<DraftTaskRow['readiness'], string> = {
  ready: 'size-8 rounded-full bg-pass',
  warnings: 'size-8 rounded-full bg-ung',
  problems: 'size-8 rounded-full border-[1.5px] border-dotted border-err bg-err-soft',
  not_run: 'size-8 rounded-full border-[1.5px] border-que',
};

function moveKey(key: string, to: number): void {
  const order = props.rows.map((r) => r.key);
  const from = order.indexOf(key);
  if (from < 0 || to < 0 || to >= order.length || from === to) return;
  order.splice(from, 1);
  order.splice(to, 0, key);
  emit('reorder', order);
}

function onHandleKey(event: KeyboardEvent, index: number, key: string): void {
  if (event.key === 'ArrowUp') moveKey(key, index - 1);
  else if (event.key === 'ArrowDown') moveKey(key, index + 1);
  else return;
  event.preventDefault();
}

function onDrop(index: number): void {
  if (dragging.value) moveKey(dragging.value, index);
  dragging.value = null;
}

function remove(row: DraftTaskRow): void {
  menu.value = null;
  // A task the base holds comes back with Undo; one new in the draft is gone for good.
  if (row.baseVersion === null) confirming.value = row.key;
  else emit('remove', row.key);
}

function duplicate(key: string): void {
  menu.value = null;
  emit('duplicate', key);
}

function confirmRemove(key: string): void {
  confirming.value = null;
  emit('remove', key);
}
</script>

<template>
  <div class="flex flex-col gap-8">
    <div class="tbl overflow-visible">
      <table class="dt h38 static" data-testid="draft-task-table">
        <thead>
          <tr>
            <th class="w-36">
              <span
                class="text-12 font-medium text-text-3"
                title="Drag to reorder; the order is written into suite.yaml"
                >Order</span
              >
            </th>
            <th class="w-150">Change</th>
            <th class="w-170">Readiness</th>
            <th>Task</th>
            <th>Version</th>
            <th>Summary</th>
            <th>Verification</th>
            <th class="text-right">Fixtures</th>
            <th class="w-96"><span class="text-12 font-medium text-text-3">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(row, index) in rows" :key="row.key">
            <tr
              :class="[
                row.state === 'removed' ? 'opacity-55' : '',
                dragging === row.key ? 'bg-accent-soft' : '',
              ]"
              :data-key="row.key"
              :data-state="row.state"
              :draggable="!readonly"
              @dragstart="dragging = row.key"
              @dragover.prevent
              @drop.prevent="onDrop(index)"
              @dragend="dragging = null"
            >
              <td>
                <button
                  type="button"
                  class="inline-flex cursor-grab border-0 bg-transparent p-0 text-text-3"
                  :aria-label="`Move ${row.key}: arrow keys`"
                  title="Drag to reorder"
                  :disabled="readonly"
                  @keydown="onHandleKey($event, index, row.key)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <circle cx="9" cy="6" r="1.6" />
                    <circle cx="15" cy="6" r="1.6" />
                    <circle cx="9" cy="12" r="1.6" />
                    <circle cx="15" cy="12" r="1.6" />
                    <circle cx="9" cy="18" r="1.6" />
                    <circle cx="15" cy="18" r="1.6" />
                  </svg>
                </button>
              </td>
              <td>
                <span
                  v-if="changeText(row)"
                  class="tag"
                  :class="CHANGE_TONE[row.state]"
                  data-testid="row-change"
                  >{{ changeText(row) }}</span
                >
              </td>
              <td>
                <span
                  v-if="row.state !== 'removed'"
                  class="inline-flex items-center gap-6 text-12"
                  data-testid="row-readiness"
                  ><span class="flex-none" :class="DOT[row.readiness]" aria-hidden="true" />{{
                    READINESS_WORDS[row.readiness]
                  }}</span
                >
              </td>
              <td>
                <RouterLink
                  :to="editTo(row.key)"
                  class="font-mono text-12 font-semibold"
                  :class="row.state === 'removed' ? 'text-text-3 line-through' : 'text-text'"
                  >{{ row.key }}</RouterLink
                >
              </td>
              <td>
                <span
                  class="font-mono text-12"
                  :class="
                    row.state === 'unchanged' || row.state === 'removed'
                      ? 'text-text-2'
                      : 'font-semibold text-text'
                  "
                  >{{ versionText(row) }}</span
                >
              </td>
              <td
                class="whitespace-normal"
                :class="row.state === 'removed' ? 'text-text-3 line-through' : 'text-text-2'"
              >
                {{ row.summary }}
              </td>
              <td>
                <div class="flex flex-wrap gap-4">
                  <span v-for="t in row.verificationTypes" :key="t" class="tag">{{ t }}</span>
                </div>
              </td>
              <td
                class="text-right"
                :class="row.state === 'removed' ? 'text-text-3 line-through' : 'text-text-2'"
              >
                {{ row.fixtureCount }}
              </td>
              <td class="relative">
                <button
                  v-if="row.state === 'removed'"
                  type="button"
                  class="btn sm"
                  :disabled="readonly"
                  @click="emit('undo', row.key)"
                >
                  Undo
                </button>
                <span v-else-if="confirming === row.key" class="inline-flex items-center gap-4">
                  <button type="button" class="btn sm danger" @click="confirmRemove(row.key)">
                    Remove
                  </button>
                  <button type="button" class="btn sm ghost" @click="confirming = null">
                    Keep
                  </button>
                </span>
                <span v-else class="inline-flex items-center gap-4">
                  <RouterLink class="btn sm ghost" :to="editTo(row.key)">Edit</RouterLink>
                  <button
                    type="button"
                    class="btn sm ghost px-6"
                    :aria-label="`More actions for ${row.key}`"
                    title="More actions"
                    aria-haspopup="menu"
                    :aria-expanded="menu === row.key"
                    :disabled="readonly"
                    @click="menu = menu === row.key ? null : row.key"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="5" cy="12" r="1.8" />
                      <circle cx="12" cy="12" r="1.8" />
                      <circle cx="19" cy="12" r="1.8" />
                    </svg>
                  </button>
                </span>
                <div
                  v-if="menu === row.key"
                  role="menu"
                  class="absolute top-34 right-8 z-5 flex w-200 flex-col rounded-6 border border-border bg-surface p-4 shadow-float"
                  @keydown.esc="menu = null"
                >
                  <RouterLink
                    role="menuitem"
                    class="rounded-4 px-10 py-6 text-text hover:bg-surface-2 hover:no-underline"
                    :to="editTo(row.key)"
                    >Edit</RouterLink
                  >
                  <button
                    type="button"
                    role="menuitem"
                    class="rounded-4 px-10 py-6 text-left hover:bg-surface-2"
                    @click="duplicate(row.key)"
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    class="rounded-4 px-10 py-6 text-left text-fail-text hover:bg-surface-2"
                    @click="remove(row)"
                  >
                    Remove from suite
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="row.state === 'removed'" class="bg-surface-2">
              <td />
              <td colspan="8" class="h-auto px-12 pt-8 pb-10 whitespace-normal">
                <span class="text-12 text-text-2"
                  >Removes <code>{{ path }}/{{ row.key }}/</code> when you save.<template
                    v-if="baseVersion"
                  >
                    v{{ baseVersion }} and earlier keep it, and History can restore it.</template
                  ></span
                >
              </td>
            </tr>
            <tr v-if="confirming === row.key">
              <td />
              <td
                colspan="8"
                class="h-auto px-12 pt-6 pb-8 text-12 whitespace-normal text-fail-text"
              >
                Remove <code>{{ row.key }}</code
                >? It is new in this draft, so removing it can't be undone.
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p class="m-0 text-12 text-text-3">
      Drag rows to change the order; it is written into <code>suite.yaml</code>. Readiness updates
      as you edit; tasks you haven't touched keep the result of their last self-check.
    </p>
  </div>
</template>
