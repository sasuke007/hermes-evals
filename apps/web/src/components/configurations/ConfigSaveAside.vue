<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';
import { RouterLink } from 'vue-router';
import type { ConfigChange, SaveState } from './configForm';

/**
 * The sticky aside of the configuration form (ConfigForm board): what saving does, the
 * change summary ("max_turns 20 → 30", struck old value, bold new one), the save failure
 * with the server's message (ConfigFormStates › Save failed: changes kept, the button
 * retries), Save with the line under it, and Cancel.
 */
withDefaults(
  defineProps<{
    title: string;
    /** create mode: what saving does. */
    intro?: string | null;
    /** null: no change list (a new configuration). */
    changes?: ConfigChange[] | null;
    /** A heading over the change list when it follows the intro (a duplicate). */
    changesTitle?: string | null;
    /** The failed request, verbatim. */
    error?: string | null;
    save: SaveState;
    busy?: boolean;
    cancelTo: RouteLocationRaw;
  }>(),
  { intro: null, changes: null, changesTitle: null, error: null, busy: false },
);
defineEmits<{ save: [] }>();
</script>

<template>
  <aside
    class="sticky top-16 flex max-w-380 min-w-0 flex-[1_1_300px] flex-col gap-12 max-md:static max-md:max-w-none"
    aria-label="Save"
  >
    <div class="flex flex-col gap-10 rounded-6 border border-border bg-surface p-16">
      <h2 class="text-15 font-semibold">{{ title }}</h2>
      <p v-if="intro" class="text-text-2">{{ intro }}</p>
      <template v-if="changes">
        <h3 v-if="changesTitle" class="text-12 font-medium text-text-2">{{ changesTitle }}</h3>
        <p v-if="changes.length === 0" class="text-text-3">No changes yet.</p>
        <ul v-else class="flex flex-col gap-6" data-testid="changes">
          <li
            v-for="c in changes"
            :key="c.field"
            class="grid grid-cols-[110px_minmax(0,1fr)] gap-8 text-12"
            :data-field="c.field"
          >
            <span class="font-mono text-text-2">{{ c.field }}</span>
            <span class="font-mono wrap-anywhere"
              ><span class="text-text-3 line-through">{{ c.before }}</span> →
              <b>{{ c.after }}</b></span
            >
          </li>
        </ul>
      </template>
      <div
        v-if="error"
        role="alert"
        class="flex flex-col gap-4 rounded-6 border border-fail bg-fail-soft px-12 py-10"
        data-testid="save-error"
      >
        <b class="text-fail-text">Save failed</b>
        <code class="whitespace-normal text-text-2 wrap-anywhere">{{ error }}</code>
        <span class="text-12 text-text-3"
          >Nothing was saved and your changes are kept. Try again.</span
        >
      </div>
      <div class="flex flex-col gap-6 border-t border-border pt-10">
        <button
          type="button"
          class="btn primary"
          :disabled="save.disabled || busy"
          :aria-describedby="'save-hint'"
          data-testid="save"
          @click="$emit('save')"
        >
          {{ busy ? 'Saving…' : save.label }}
        </button>
        <span
          id="save-hint"
          class="text-12"
          :class="save.hintTone === 'error' ? 'text-fail-text' : 'text-text-3'"
          data-testid="save-hint"
          >{{ save.hint }}</span
        >
        <RouterLink class="btn" :to="cancelTo">Cancel</RouterLink>
      </div>
    </div>
  </aside>
</template>
