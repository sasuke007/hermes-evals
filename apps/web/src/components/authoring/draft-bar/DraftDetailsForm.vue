<script setup lang="ts">
import { useId } from 'vue';

/**
 * Edit details of a suite draft (SA.3): the name, fixed after the first save; the version
 * label, which may not be empty ("Add a version label.", a suite-level problem that blocks
 * Review and save); and an optional description. Each change goes into the draft at once;
 * suite.yaml is written when the draft is saved.
 */
const props = withDefaults(
  defineProps<{
    name: string;
    versionLabel: string;
    description: string | null;
    nextVersion: number;
    readonly?: boolean;
  }>(),
  { readonly: false },
);
const emit = defineEmits<{
  label: [value: string];
  description: [value: string | null];
  done: [];
}>();
const ids = useId();
const empty = () => props.versionLabel.trim() === '';
</script>

<template>
  <section
    aria-label="Suite details"
    class="grid grid-cols-3 gap-16 rounded-6 border border-border bg-surface px-20 py-16 max-lg:grid-cols-1"
    data-testid="draft-details"
  >
    <div class="flex flex-col gap-4">
      <span class="text-12 font-medium text-text-2">Name</span>
      <span class="flex h-32 items-center font-mono">{{ name }}</span>
      <span class="text-12 text-text-3">Fixed after the first save.</span>
    </div>
    <label class="flex flex-col gap-4" :for="`${ids}-label`">
      <span class="text-12 font-medium text-text-2">Version label</span>
      <input
        :id="`${ids}-label`"
        class="input font-mono"
        :class="empty() ? 'border-fail' : ''"
        :value="versionLabel"
        :readonly="readonly"
        :aria-invalid="empty() ? 'true' : undefined"
        :aria-describedby="`${ids}-label-help`"
        @input="emit('label', ($event.target as HTMLInputElement).value)"
      />
      <span v-if="empty()" :id="`${ids}-label-help`" role="alert" class="text-12 text-fail-text"
        >Add a version label.</span
      >
      <span v-else :id="`${ids}-label-help`" class="text-12 text-text-3"
        >Your own label. The platform numbers versions itself (v1, v2, …).</span
      >
    </label>
    <label class="flex flex-col gap-4" :for="`${ids}-desc`">
      <span class="text-12 font-medium text-text-2">Description</span>
      <textarea
        :id="`${ids}-desc`"
        class="input h-auto px-10 py-6"
        rows="2"
        :value="description ?? ''"
        :readonly="readonly"
        @input="emit('description', ($event.target as HTMLTextAreaElement).value || null)"
      />
      <span class="text-12 text-text-3">Optional.</span>
    </label>
    <div class="col-span-full flex items-center justify-between gap-12">
      <span class="text-12 text-text-3"
        >Changes go into the draft and are written to <code>suite.yaml</code> when you
        save.<template v-if="empty()">
          The draft bar's <b>Review and save as v{{ nextVersion }}</b> is disabled while the label
          is empty.</template
        ></span
      >
      <button type="button" class="btn sm" @click="emit('done')">Done</button>
    </div>
  </section>
</template>
