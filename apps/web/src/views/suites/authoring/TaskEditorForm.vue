<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { JsonValue } from '@hermes-evals/shared';
import type { ReadinessTarget } from '@/api/types/authoring';
import ChecksSection from '@/components/authoring/checks/ChecksSection.vue';
import CodeText from '@/components/authoring/editors/CodeText.vue';
import EditorNote from '@/components/authoring/editors/EditorNote.vue';
import { useDraftTaskStore } from '@/stores/draftTask';
import { useDraftTaskToolsStore } from '@/stores/draftTaskTools';
import AnswerSection from './sections/AnswerSection.vue';
import AnswersFromFixtures from './sections/AnswersFromFixtures.vue';
import EditorSection from './sections/EditorSection.vue';
import ExpectedSection from './sections/ExpectedSection.vue';
import FilesPart from './sections/FilesPart.vue';
import LimitsSection from './sections/LimitsSection.vue';
import PromptSection from './sections/PromptSection.vue';
import ReferenceSection from './sections/ReferenceSection.vue';
import TaskSection from './sections/TaskSection.vue';
import { looseIssues, sectionMark } from './sections/fieldIssues';
import SectionIndex from './SectionIndex.vue';

/**
 * The Form tab (SA.4 to SA.7): task.yaml as fields, with prompt.md, the files and
 * reference.json beside them, in eight sections. Task and Limits are platform metadata;
 * Prompt and Workspace files reach the agent; Answer, Reference answer, Checks and Expected
 * workspace never do. Home files (Phase 6 seeds) show when the task has them or once added.
 * While task.yaml has an error the form is read-only under a banner that leads to the
 * task.yaml tab (SA.6). `reveal(target)` is where the readiness panel's Fix links go.
 */
const emit = defineEmits<{ openYaml: [] }>();
const task = useDraftTaskStore();
const tools = useDraftTaskToolsStore();
const root = ref<HTMLElement | null>(null);
const checksSection = ref<InstanceType<typeof ChecksSection> | null>(null);
const homeOpen = ref(false);

const readiness = computed(() => task.detail?.readiness ?? null);
const issues = computed(() => readiness.value?.issues ?? []);
const form = computed(() => task.form);
const lock = computed(() => task.detail?.formLock ?? null);
const hasHome = computed(
  () => homeOpen.value || (task.detail?.files.some((f) => f.kind === 'home_seed') ?? false),
);
const hasExpected = computed(() => !!form.value?.expectedWorkspace || !!form.value?.expectedHome);
const reference = computed<JsonValue | undefined>(() => {
  try {
    return task.reference.trim() === '' ? undefined : (JSON.parse(task.reference) as JsonValue);
  } catch {
    return undefined;
  }
});
const scripts = computed(() => task.detail?.files.filter((f) => f.kind === 'verifier') ?? []);
const checkNotes = computed(() => looseIssues(issues.value, 'checks', ['checks']));

const INDEX = [
  ['task', 'Task'],
  ['prompt', 'Prompt'],
  ['workspace', 'Workspace files'],
  ['home', 'Home files'],
  ['answer', 'Answer'],
  ['reference', 'Reference answer'],
  ['checks', 'Checks'],
  ['expected', 'Expected workspace'],
  ['limits', 'Limits'],
] as const;
const sections = computed(() =>
  INDEX.filter(
    ([id]) => (id !== 'home' || hasHome.value) && (id !== 'expected' || hasExpected.value),
  ).map(([id, label]) => ({
    id,
    label,
    mark: sectionMark(
      issues.value,
      (readiness.value?.rules ?? []).flatMap((r) =>
        r.target ? [{ section: r.target.section, status: r.status }] : [],
      ),
      id,
    ),
  })),
);

async function go(id: string): Promise<void> {
  if (id === 'home') homeOpen.value = true;
  await nextTick();
  const el = root.value?.querySelector<HTMLElement>(`#s-${id}`);
  el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  el?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}

/** A Fix link: the section, then the field it names (a check card opens first). */
async function reveal(target: ReadinessTarget): Promise<void> {
  await go(target.section);
  const field = target.field;
  if (!field) return;
  const check = /^checks\.(\d+)/.exec(field);
  if (check) await checksSection.value?.reveal(Number(check[1]));
  await nextTick();
  const section = root.value?.querySelector<HTMLElement>(`#s-${target.section}`);
  const card = check
    ? (section?.querySelectorAll<HTMLElement>('[data-testid^="check-card-"]')[Number(check[1])] ??
      null)
    : null;
  const el = card
    ? field.endsWith('.key')
      ? card.querySelector<HTMLElement>('[data-field="key"]')
      : card
    : (section?.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`) ??
      section?.querySelector<HTMLElement>(`[data-path="${CSS.escape(field)}"]`));
  const focusable = el?.matches('input, textarea, select, button')
    ? el
    : el?.querySelector<HTMLElement>('input, textarea, select, button');
  (focusable ?? el)?.focus();
}

function addExpected(): void {
  task.editForm((f) => (f.expectedWorkspace = 'expected'));
  void go('expected');
}

defineExpose({ reveal });
</script>

<template>
  <div ref="root" class="flex flex-col gap-12">
    <EditorNote v-if="lock" tone="problem" alert centered data-testid="form-lock">
      <template #lead
        ><code>task.yaml</code> has an error<template v-if="lock.line">
          on line {{ lock.line }}</template
        >.</template
      >
      Fix it in the task.yaml tab to keep editing in the form.
      <template #actions>
        <button type="button" class="btn" @click="emit('openYaml')">Open task.yaml tab</button>
      </template>
    </EditorNote>
    <SectionIndex :sections="sections" @go="go" />
    <div
      class="flex flex-col gap-16"
      :class="lock ? 'pointer-events-none opacity-62' : ''"
      :inert="!!lock || undefined"
      data-testid="form-sections"
    >
      <TaskSection />
      <PromptSection />
      <EditorSection
        id="workspace"
        title="③ Workspace files"
        zone="visible"
        caption="Copied into the agent's workspace before every run"
      >
        <FilesPart kind="fixture" />
        <AnswersFromFixtures />
      </EditorSection>
      <EditorSection
        v-if="hasHome"
        id="home"
        title="Home files"
        zone="visible"
        caption="Copied into the agent's home before every run"
      >
        <FilesPart kind="home_seed" />
      </EditorSection>
      <AnswerSection />
      <ReferenceSection />
      <EditorSection id="checks" title="⑥ Checks" zone="hidden">
        <EditorNote
          v-for="(n, i) in checkNotes"
          :key="i"
          :tone="n.severity === 'problem' ? 'problem' : 'warning'"
          ><CodeText :text="n.message"
        /></EditorNote>
        <ChecksSection
          v-if="form"
          ref="checksSection"
          :checks="form.checks"
          :answer-path="form.answerPath"
          :reference="reference"
          :reference-values="readiness?.referenceValues ?? []"
          :issues="issues"
          :tries="tools.tries"
          :self-check="task.detail?.selfCheck ?? null"
          :self-check-running="tools.selfCheckState === 'running'"
          :expected-folder="form.expectedWorkspace"
          :scripts="scripts"
          :sources="tools.sources"
          :rubrics="task.rubrics"
          :readonly="task.locked"
          @update="task.editForm((f) => (f.checks = $event))"
          @reply="tools.setReply"
          @run-self-check="tools.runSelfCheck"
          @rubric="task.editRubric"
          @load-source="tools.loadSource"
        />
      </EditorSection>
      <ExpectedSection v-if="hasExpected" />
      <LimitsSection />
      <div
        v-if="!hasExpected || !hasHome"
        class="flex flex-wrap items-center gap-10 rounded-6 border border-dashed border-border-strong px-16 py-12"
      >
        <template v-if="!hasExpected">
          <button type="button" class="btn" @click="addExpected">+ Add expected workspace</button>
          <span class="text-12 text-text-3"
            >Only File checks need one: the files a correct agent would leave. Hidden from the
            agent.</span
          >
        </template>
        <button v-if="!hasHome" type="button" class="btn ghost" @click="go('home')">
          + Add home files
        </button>
      </div>
    </div>
  </div>
</template>
