<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { errorMessage } from '@/api/client';
import { SKILL_ZIP_MAX_BYTES } from '@/api/resources';
import type { SkillUploadValidation, UploadCheck } from '@/api/types/resources';
import BaseDialog from '@/components/ui/BaseDialog.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { useResourcesStore } from '@/stores/resources';
import { formatBytes, formatSha256, plural } from '@/lib/format';
import { fileTreeText } from './format';
import UploadDropZone from './UploadDropZone.vue';
import UploadFileRow from './UploadFileRow.vue';
import UploadProblem from './UploadProblem.vue';

/**
 * Upload skill, in two steps (ResourcesSkills board and the Library states): choose or drop
 * a zip, then read the API's dry run (POST /resources/skills/validate, which stores nothing)
 * and confirm with its token. A new version of an existing name says which version it
 * becomes; the same version with other content, or an invalid zip, lists its problems and
 * Confirm stays disabled.
 */
const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ uploaded: [id: string] }>();

const store = useResourcesStore();

type Step = 'choose' | 'validating' | 'review';
const step = ref<Step>('choose');
const file = ref<File | null>(null);
const result = ref<SkillUploadValidation | null>(null);
/** The dry run itself failed (413, a network error), or the zip is over the cap. */
const requestError = ref<string | null>(null);
const tooLarge = ref(false);
const confirming = ref(false);
const confirmError = ref<string | null>(null);

function reset(): void {
  step.value = 'choose';
  file.value = null;
  result.value = null;
  requestError.value = null;
  tooLarge.value = false;
  confirming.value = false;
  confirmError.value = null;
}
watch(open, (isOpen) => {
  if (isOpen) reset();
});

/** Each pick starts a new dry run; an answer for an older pick is dropped. */
let attempt = 0;
async function choose(picked: File): Promise<void> {
  const mine = ++attempt;
  reset();
  file.value = picked;
  if (picked.size > SKILL_ZIP_MAX_BYTES) {
    tooLarge.value = true;
    step.value = 'review';
    return;
  }
  step.value = 'validating';
  try {
    const validation = await store.validateSkill(picked);
    if (mine === attempt) result.value = validation;
  } catch (err) {
    if (mine === attempt) requestError.value = errorMessage(err);
  } finally {
    if (mine === attempt) step.value = 'review';
  }
}

async function confirm(): Promise<void> {
  const token = result.value?.token;
  if (!token || confirming.value) return;
  confirming.value = true;
  confirmError.value = null;
  try {
    const row = await store.confirmSkill(token);
    open.value = false;
    emit('uploaded', row.id);
  } catch (err) {
    confirmError.value = errorMessage(err);
  } finally {
    confirming.value = false;
  }
}

const stepLabel = computed(() =>
  step.value === 'choose' ? 'Step 1 of 2 · choose file' : 'Step 2 of 2 · review',
);
const accepted = computed(
  () => result.value?.outcome === 'valid' || result.value?.outcome === 'new_version',
);
const problemCount = computed(() => (tooLarge.value ? 1 : (result.value?.problems.length ?? 0)));
/** Problems, or a failed request: the secondary button picks another file. */
const refused = computed(() => step.value === 'review' && !accepted.value);
const confirmLabel = computed(() =>
  result.value?.outcome === 'new_version' && result.value.version
    ? `Upload as ${result.value.version}`
    : 'Confirm upload',
);
const confirmDisabled = computed(
  () => step.value !== 'review' || !result.value?.token || confirming.value,
);

/** Names, versions and hashes are values: mono. */
const MONO_CHECKS = new Set(['name', 'version', 'content hash']);
function checkValue(check: UploadCheck): string {
  return check.label === 'content hash' ? formatSha256(check.value, 12) : check.value;
}
/** Beside the hash of a same-version conflict: the stored version's hash. */
const storedNote = computed(() => {
  const r = result.value;
  if (r?.outcome !== 'conflict' || !r.existing) return null;
  return `(stored ${r.existing.version}: ${r.existing.contentHash.slice(0, 8)})`;
});
const tree = computed(() => {
  const r = result.value;
  if (!r || r.fileTree.length === 0) return null;
  return {
    summary: `File tree · ${plural(r.fileTree.length, 'file')}`,
    text: fileTreeText(r.name, r.fileTree),
  };
});
</script>

<template>
  <BaseDialog
    v-model:open="open"
    title="Upload skill"
    :width="600"
    body-class="flex flex-col gap-12 p-16"
    data-testid="skill-upload-dialog"
  >
    <template #header-extra>
      <span class="text-12 text-text-3" data-testid="step-label">{{ stepLabel }}</span>
    </template>

    <UploadDropZone
      v-if="step === 'choose'"
      caption=".zip up to 20 MB · must contain SKILL.md at its root"
      accept=".zip,application/zip"
      @file="choose"
      >Drop a skill zip here, or choose a file</UploadDropZone
    >

    <template v-else-if="file">
      <UploadFileRow
        :name="result?.fileName ?? file.name"
        :size-bytes="result?.sizeBytes ?? file.size"
        :oversize="tooLarge"
        :replaceable="step === 'review' && accepted"
        @replace="reset"
      />

      <div
        v-if="step === 'validating'"
        class="flex items-center gap-8 text-text-2"
        role="status"
        data-testid="validating"
      >
        <span
          class="size-12 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
          aria-hidden="true"
        />
        Checking the zip. Nothing is stored yet.
      </div>

      <ErrorBanner
        v-else-if="requestError"
        title="The zip could not be checked"
        :detail="requestError"
        compact
      />

      <template v-else-if="tooLarge">
        <div class="font-semibold text-fail-text" data-testid="upload-lead">
          1 problem. Nothing was stored.
        </div>
        <UploadProblem
          boxed
          :title="`${formatBytes(file.size)} is over the 20 MB limit.`"
          detail="Leave out files the skill does not need, then zip it again."
        />
      </template>

      <template v-else-if="result">
        <div
          v-if="accepted"
          class="flex items-center gap-8 font-semibold text-pass-text"
          data-testid="upload-lead"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path
              d="M5 8.3l2 2 4-4.3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          Valid skill · nothing stored yet
        </div>
        <div v-else class="font-semibold text-fail-text" data-testid="upload-lead">
          {{ plural(problemCount, 'problem') }}. Nothing was stored.
        </div>

        <ul
          v-if="result.checks.length"
          class="flex flex-col rounded-4 border border-border"
          aria-label="Checks"
        >
          <li
            v-for="check in result.checks"
            :key="check.label"
            class="grid grid-cols-[18px_130px_minmax(0,1fr)] items-start gap-8 border-b border-border px-12 py-8 last:border-b-0"
            :data-ok="check.ok"
            data-testid="upload-check"
          >
            <svg
              v-if="check.ok"
              width="14"
              height="14"
              viewBox="0 0 14 14"
              class="mt-3 text-pass"
              aria-label="passed"
            >
              <path
                d="M2.5 7.5l3 3 6-7"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <svg
              v-else
              width="14"
              height="14"
              viewBox="0 0 14 14"
              class="mt-3 text-fail"
              aria-label="failed"
            >
              <path
                d="M3.5 3.5l7 7M10.5 3.5l-7 7"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
            <span class="text-text-2">{{ check.label }}</span>
            <span
              class="min-w-0 text-12 leading-20 break-words"
              :class="{ 'font-mono': MONO_CHECKS.has(check.label) }"
              >{{ checkValue(check)
              }}<span v-if="check.label === 'content hash' && storedNote" class="text-text-3">
                {{ storedNote }}</span
              ></span
            >
          </li>
        </ul>

        <div
          v-if="result.outcome === 'new_version' && result.existing"
          class="flex items-start gap-10 rounded-4 border border-border-strong bg-accent-soft px-12 py-10"
          role="status"
          data-testid="new-version"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
            class="mt-2 flex-none text-accent"
          >
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path
              d="M8 7.2v4M8 4.8h.01"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
          <span class="text-text-2"
            ><code class="text-text">{{ result.name }}</code> {{ result.existing.version }} already
            exists. This upload becomes version <b class="text-text">{{ result.version }}</b> (from
            its SKILL.md). Configurations keep the version they reference.</span
          >
        </div>

        <template v-if="result.problems.length && result.checks.length">
          <UploadProblem
            v-for="problem in result.problems"
            :key="problem.title"
            boxed
            :title="problem.title"
            :detail="problem.detail"
          />
        </template>
        <ul
          v-else-if="result.problems.length"
          class="flex flex-col rounded-4 border border-border [&>li:not(:last-child)]:border-b [&>li:not(:last-child)]:border-border"
          aria-label="Problems"
        >
          <li v-for="problem in result.problems" :key="problem.title">
            <UploadProblem :title="problem.title" :detail="problem.detail" />
          </li>
        </ul>

        <details v-if="tree">
          <summary class="cursor-pointer text-12 text-text-2">{{ tree.summary }}</summary>
          <pre
            class="mt-6 overflow-x-auto rounded-4 bg-surface-2 p-10 font-mono text-12 leading-18"
            data-testid="file-tree"
            >{{ tree.text }}</pre>
        </details>
      </template>

      <ErrorBanner
        v-if="confirmError"
        title="The skill was not stored"
        :detail="confirmError"
        compact
      />
    </template>

    <template #footer>
      <button v-if="refused" type="button" class="btn" @click="reset">Choose another file</button>
      <button v-else type="button" class="btn" @click="open = false">Cancel</button>
      <button
        type="button"
        class="btn primary"
        :disabled="confirmDisabled"
        data-testid="confirm-upload"
        @click="confirm"
      >
        {{ confirming ? 'Storing…' : confirmLabel }}
      </button>
    </template>
  </BaseDialog>
</template>
