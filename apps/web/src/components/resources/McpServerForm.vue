<script setup lang="ts">
import { computed, onMounted, reactive, ref, useId, watch } from 'vue';
import { McpServerInputSchema } from '@hermes-evals/shared';
import { errorMessage, isApiError } from '@/api/client';
import type { McpServerInput, McpServerRow, McpTestView } from '@/api/types/resources';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { usePolling } from '@/composables/usePolling';
import { useResourcesStore } from '@/stores/resources';
import ChipListInput from './ChipListInput.vue';
import { joinArgs, splitArgs } from './format';
import McpHttpFields from './McpHttpFields.vue';
import McpFormRow from './McpFormRow.vue';
import McpStdioFields from './McpStdioFields.vue';
import McpTestResult from './McpTestResult.vue';
import McpVersionNotice from './McpVersionNotice.vue';

/**
 * Define or edit an MCP server (McpServerForm on the ResourcesMcp board, MCP secrets states).
 * Each transport says what it means for a run and what the agent can read: under a stdio
 * server's variables the amber caution, under an http server's headers the egress note.
 * Names only, never values. Test start runs what the form holds (a saved, unchanged server
 * is tested by id and its row records the result). Editing a server a configuration uses
 * saves its next version; one nobody uses changes in place. The shared input schema checks
 * the form before it is sent, and the API's 400 issues and 409 land on their fields.
 */
const props = defineProps<{ server: McpServerRow | null }>();
const emit = defineEmits<{ saved: [row: McpServerRow]; cancel: [] }>();

const store = useResourcesStore();
const uid = useId();
const ids = { name: `mcp-name-${uid}`, timeout: `mcp-timeout-${uid}`, title: `mcp-form-${uid}` };

interface Draft {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  envNames: string[];
  url: string;
  headers: McpServerInput['headers'];
  include: string[];
  exclude: string[];
  timeout: string;
}
function draftOf(s: McpServerInput | null): Draft {
  return {
    name: s?.name ?? '',
    transport: s?.transport ?? 'stdio',
    command: s?.command ?? '',
    args: joinArgs(s?.args ?? []),
    envNames: [...(s?.envNames ?? [])],
    url: s?.url ?? '',
    headers: (s?.headers ?? []).map((h) => ({ ...h })),
    include: [...(s?.include ?? [])],
    exclude: [...(s?.exclude ?? [])],
    timeout: String(s?.timeoutS ?? 30),
  };
}
function inputOf(d: Draft): McpServerInput {
  const stdio = d.transport === 'stdio';
  return {
    name: d.name.trim(),
    transport: d.transport,
    command: stdio ? d.command.trim() : null,
    args: stdio ? splitArgs(d.args) : [],
    envNames: stdio ? d.envNames : [],
    url: stdio ? null : d.url.trim(),
    headers: stdio ? [] : d.headers,
    include: d.include,
    exclude: d.exclude,
    timeoutS: /^\d+$/.test(d.timeout.trim()) ? Number(d.timeout.trim()) : Number.NaN,
  };
}

const draft = reactive<Draft>(draftOf(props.server));
const input = computed(() => inputOf(draft));
const editing = computed(() => props.server !== null);
const row = computed(() =>
  props.server ? (store.mcpServers.byId[props.server.id] ?? props.server) : null,
);
/** Unchanged from the saved definition: Test start tests it by id. */
const pristine = computed(
  () =>
    !!props.server &&
    JSON.stringify(inputOf(draftOf(props.server))) === JSON.stringify(input.value),
);

// ── field errors: the shared schema on submit, then live; the API's issues on top ─────────
const attempted = ref(false);
const apiIssues = ref<Record<string, string>>({});
const formError = ref<string | null>(null);
const FIELDS = [
  'name',
  'command',
  'args',
  'envNames',
  'url',
  'headers',
  'include',
  'exclude',
  'timeoutS',
];
function issuesOf(value: McpServerInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (Number.isNaN(value.timeoutS)) out.timeoutS = 'timeout must be 1 to 3600 seconds';
  const parsed = McpServerInputSchema.safeParse(
    Number.isNaN(value.timeoutS) ? { ...value, timeoutS: 30 } : value,
  );
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? '');
      if (FIELDS.includes(field)) out[field] ??= issue.message;
    }
  }
  return out;
}
const issues = computed(() => ({
  ...(attempted.value ? issuesOf(input.value) : {}),
  ...apiIssues.value,
}));
const errorOf = (field: string): string | null => issues.value[field] ?? null;
const errId = (field: string): string => `mcp-${field}-error-${uid}`;
watch(
  input,
  () => {
    apiIssues.value = {};
    formError.value = null;
  },
  { deep: true },
);

/** Checks the form; false (and errors shown) when it would be refused. */
function check(): boolean {
  attempted.value = true;
  return Object.keys(issuesOf(input.value)).length === 0;
}

// ── save ─────────────────────────────────────────────────────────────────
const saving = ref(false);
async function save(): Promise<void> {
  if (saving.value || !check()) return;
  saving.value = true;
  formError.value = null;
  try {
    emit('saved', await store.saveMcpServer(input.value, props.server?.id));
  } catch (err) {
    if (isApiError(err) && err.status === 400 && err.issues.length) {
      apiIssues.value = Object.fromEntries(
        err.issues.map((i) => [i.path.split('.')[0] ?? '', i.message] as const),
      );
    } else if (isApiError(err) && err.status === 409) {
      apiIssues.value = { name: err.detail };
    } else {
      formError.value = errorMessage(err);
    }
  } finally {
    saving.value = false;
  }
}

// ── Test start ───────────────────────────────────────────────────────────
const testing = ref(false);
const testError = ref<string | null>(null);
/** The result of testing what the form held, when that was not the saved definition. */
const unsavedResult = ref<McpTestView | null>(null);
async function test(): Promise<void> {
  if (testing.value || !check()) return;
  testing.value = true;
  testError.value = null;
  unsavedResult.value = null;
  try {
    if (pristine.value && props.server) await store.testMcpServer({ id: props.server.id });
    else unsavedResult.value = await store.testMcpServer(input.value);
  } catch (err) {
    testError.value = errorMessage(err);
  } finally {
    testing.value = false;
  }
}
/** The saved server's own last test (recorded on its row) while the form still holds it. */
const shownResult = computed<McpTestView | null>(() => {
  if (unsavedResult.value) return unsavedResult.value;
  const last = row.value?.lastTest;
  return pristine.value && last && last.status !== 'untested' ? last : null;
});
watch(input, () => (unsavedResult.value = null), { deep: true });
// A saved test still running when the API stopped waiting: read the row until it ends.
usePolling(
  () => store.loadMcpServers(),
  3_000,
  () => pristine.value && row.value?.lastTest.status === 'running',
);

// ── copy ─────────────────────────────────────────────────────────────────
const stdio = computed(() => draft.transport === 'stdio');
const nextVersion = computed(() => (props.server ? props.server.version + 1 : 1));
const saveLabel = computed(() => {
  if (!props.server) return 'Save MCP server';
  return props.server.frozen ? `Save as version ${nextVersion.value}` : 'Save changes';
});

const nameInput = ref<HTMLInputElement | null>(null);
onMounted(() => {
  const el = nameInput.value;
  el?.closest('form')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  el?.focus({ preventScroll: true });
});
</script>

<template>
  <form
    class="tbl overflow-visible shadow-float"
    :aria-labelledby="ids.title"
    novalidate
    data-testid="mcp-form"
    @submit.prevent="save"
  >
    <div class="flex items-center justify-between gap-12 border-b border-border px-20 py-14">
      <h2 :id="ids.title" class="text-15 font-semibold">
        {{ editing ? 'Edit MCP server' : 'Define MCP server' }}
      </h2>
      <span v-if="server" class="text-12 text-text-3"
        >{{ server.name }} · v{{ server.version }}</span
      >
    </div>

    <McpVersionNotice v-if="server" :server="server" />

    <McpFormRow
      label="Name"
      :for="ids.name"
      help="Shown as the prefix on its tool calls in run timelines."
    >
      <input
        :id="ids.name"
        ref="nameInput"
        v-model="draft.name"
        class="input w-full max-w-320 font-mono"
        autocomplete="off"
        spellcheck="false"
        :aria-invalid="errorOf('name') ? 'true' : undefined"
        :aria-describedby="errorOf('name') ? errId('name') : undefined"
      />
      <p v-if="errorOf('name')" :id="errId('name')" class="mt-4 text-12 text-fail-text">
        {{ errorOf('name') }}
      </p>
    </McpFormRow>

    <McpFormRow label="Transport">
      <div
        class="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-12"
        role="radiogroup"
        aria-label="Transport"
      >
        <label
          v-for="option in ['stdio', 'http'] as const"
          :key="option"
          class="flex cursor-pointer items-start gap-10 rounded-6 border p-12"
          :class="
            draft.transport === option
              ? 'border-accent bg-accent-soft'
              : 'border-border-strong bg-surface'
          "
        >
          <input
            v-model="draft.transport"
            type="radio"
            name="transport"
            :value="option"
            class="mt-3"
          />
          <span class="flex flex-col gap-2">
            <b class="font-mono">{{ option }}</b>
            <span v-if="option === 'stdio'" class="text-text-2"
              >Started fresh for every run, inside that run's sandboxed container, and stopped when
              the run ends. No state carries between runs.</span
            >
            <span v-else class="text-text-2"
              >Hosted by you and reached over the network. It is <b>not reset between runs</b>, so
              runs can see each other's writes.</span
            >
          </span>
        </label>
      </div>
    </McpFormRow>

    <McpStdioFields
      v-if="stdio"
      v-model:command="draft.command"
      v-model:args="draft.args"
      v-model:env-names="draft.envNames"
      :errors="issues"
      :id-prefix="`mcp-${uid}`"
    />
    <McpHttpFields
      v-else
      v-model:url="draft.url"
      v-model:headers="draft.headers"
      :errors="issues"
      :id-prefix="`mcp-${uid}`"
    />

    <McpFormRow label="Tool filter" help="Empty include means all tools.">
      <div class="grid max-w-760 grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-12">
        <div v-for="key in ['include', 'exclude'] as const" :key="key" class="flex flex-col gap-4">
          <span class="text-12 leading-20 font-medium text-text-2">{{
            key === 'include' ? 'Include' : 'Exclude'
          }}</span>
          <ChipListInput
            v-model="draft[key]"
            :label="key === 'include' ? 'Included tools' : 'Excluded tools'"
            :input-label="key === 'include' ? 'Add included tool' : 'Add excluded tool'"
            placeholder="Add tool name"
            :invalid="!!errorOf(key)"
            :described-by="errorOf(key) ? errId(key) : null"
          />
          <p v-if="errorOf(key)" :id="errId(key)" class="text-12 text-fail-text">
            {{ errorOf(key) }}
          </p>
        </div>
      </div>
    </McpFormRow>

    <McpFormRow label="Timeout" :for="ids.timeout" help="Per tool call.">
      <div class="flex w-160 flex-col gap-4">
        <input
          :id="ids.timeout"
          v-model="draft.timeout"
          class="input font-mono"
          inputmode="numeric"
          :aria-invalid="errorOf('timeoutS') ? 'true' : undefined"
          :aria-describedby="errorOf('timeoutS') ? errId('timeoutS') : `${ids.timeout}-unit`"
        />
        <span :id="`${ids.timeout}-unit`" class="text-12 text-text-3">seconds</span>
        <p v-if="errorOf('timeoutS')" :id="errId('timeoutS')" class="text-12 text-fail-text">
          {{ errorOf('timeoutS') }}
        </p>
      </div>
    </McpFormRow>

    <McpFormRow
      label="Test"
      :help="
        stdio
          ? 'Starts the server once in a sandboxed container, as a run would, and lists its tools.'
          : 'Connects once through egress, as a run would, and lists its tools.'
      "
      last
    >
      <div class="flex max-w-760 flex-col gap-8">
        <span class="text-12 text-text-3">{{
          stdio
            ? 'The test runs in a sandboxed container with the same isolation as a run.'
            : 'The test goes through egress, as a run would, and egress adds the headers on the way.'
        }}</span>
        <div>
          <button
            type="button"
            class="btn"
            :disabled="testing"
            data-testid="test-start"
            @click="test"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden="true"
              :class="{ 'animate-spin': testing }"
            >
              <path d="M3.5 2.2l6 3.8-6 3.8z" fill="currentColor" />
            </svg>
            {{ testing ? 'Starting…' : 'Test start' }}
          </button>
        </div>
        <ErrorBanner v-if="testError" title="Test start did not run" :detail="testError" compact />
        <McpTestResult
          v-else-if="shownResult && !testing"
          :result="shownResult"
          :transport="draft.transport"
          :unsaved="unsavedResult !== null"
        />
      </div>
    </McpFormRow>

    <div v-if="formError" class="px-20 pb-14">
      <ErrorBanner title="The MCP server was not saved" :detail="formError" compact />
    </div>
    <div class="flex justify-end gap-8 border-t border-border px-20 py-14">
      <button type="button" class="btn" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="btn primary" :disabled="saving" data-testid="save-mcp">
        {{ saving ? 'Saving…' : saveLabel }}
      </button>
    </div>
  </form>
</template>
