<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import ApprovalPill from '@/components/model-access/ApprovalPill.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import { formatClock } from '@/lib/format';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import { useThemeStore } from '@/stores/theme';

/**
 * The 48px top bar (not a sidebar: every screen is wide tables, and width is the scarce
 * resource). Four work sections on the left; on the right the status zone: ApprovalPill
 * (while a Nous login waits with the dialog closed) · the live pill ("2 running · 127 / 300
 * scored"; amber "1 running · no worker", or amber "Reconnecting (attempt 3) · last update
 * 15:23:42" while the summary stream is down, and "Offline · Retry" once it has been down for
 * 30 s) · divider · System with its status dot · theme toggle. Under the bar, the amber banner
 * when Nous Portal is not connected, its login needs renewing, or an API-key provider in use
 * has no key. It shows on every page except Suites, which never call a model (UI_FLOWS 19 #4:
 * Resources show it). When Nous cannot be connected from the UI (the development host proxy
 * is down, or the login service is unavailable) its action opens System, where the row shows
 * the command, instead of a Connect the API would refuse; on System itself it has no action.
 * Below 1024px the nav wraps to a second row; nothing hides behind a menu.
 */
type ShellSection = 'experiments' | 'suites' | 'configurations' | 'resources' | 'system';

const SECTIONS: { id: Exclude<ShellSection, 'system'>; label: string; to: string }[] = [
  { id: 'experiments', label: 'Experiments', to: '/experiments' },
  { id: 'suites', label: 'Suites', to: '/suites' },
  { id: 'configurations', label: 'Configurations', to: '/configurations' },
  { id: 'resources', label: 'Resources', to: '/resources' },
];
/** Pages that never call a model: no provider banner there. */
const NO_BANNER_SECTIONS: ShellSection[] = ['suites'];

/** A section link in the bar (the canvas .navlink). */
const NAVLINK =
  'inline-flex items-center gap-7 rounded-4 px-10 font-medium text-text-2 no-underline hover:bg-surface-2 hover:text-text hover:no-underline aria-[current=page]:bg-surface-3 aria-[current=page]:text-text';
/** A pill in the status zone. */
const PILL =
  'inline-flex h-28 items-center gap-8 rounded-4 px-10 text-12 whitespace-nowrap no-underline hover:no-underline';
const AMBER_PILL = `${PILL} border border-ung bg-ung-soft font-medium text-ung-text hover:text-ung-text`;
/** The summary stream has been down for 30 s (LiveIndicator's offline state). */
const OFFLINE_PILL = `${PILL} border border-fail bg-fail-soft font-medium text-fail-text`;
/** The banner's one action (the canvas .bannerbtn). */
const BANNER_ACTION =
  'inline-flex h-26 items-center rounded-4 border-0 bg-accent px-10 text-12 font-medium whitespace-nowrap text-on-accent no-underline hover:bg-accent-hover hover:text-on-accent hover:no-underline';

const route = useRoute();
const theme = useThemeStore();
const providers = useProvidersStore();
const system = useSystemStore();

/** route.meta.section wins; otherwise the first path segment. */
const active = computed<ShellSection | null>(() => {
  const fromMeta = route.meta.section;
  if (typeof fromMeta === 'string') return fromMeta as ShellSection;
  const first = route.path.split('/')[1] ?? '';
  return (
    (['experiments', 'suites', 'configurations', 'resources', 'system'] as const).find(
      (s) => s === first,
    ) ?? null
  );
});

const isDark = computed(() => theme.theme === 'dark');
const themeLabel = computed(() =>
  isDark.value ? 'Switch to light theme' : 'Switch to dark theme',
);

const running = computed(() => system.running);
const offline = computed(() => system.liveState === 'offline');
const reconnecting = computed(() => system.liveState === 'reconnecting');
const showLive = computed(
  () => running.value.count > 0 && !system.noWorker && !reconnecting.value && !offline.value,
);
const showReconnecting = computed(
  () => running.value.count > 0 && !system.noWorker && reconnecting.value,
);
const showNoWorker = computed(() => running.value.count > 0 && system.noWorker && !offline.value);
const noWorkerTo = computed(() => {
  const only = running.value.experiments.length === 1 ? running.value.experiments[0] : undefined;
  return only ? `/experiments/${only.id}` : '/experiments';
});
const reconnectText = computed(() =>
  system.liveAttempt > 0 ? `Reconnecting (attempt ${system.liveAttempt})` : 'Reconnecting',
);

const attention = computed(() => system.attention);
const systemTitle = computed(() =>
  attention.value
    ? 'System needs attention: a provider is not connected, no worker is online, or the sandbox is not proven'
    : 'System: model access, sandbox and workers are healthy',
);

const banner = computed(() => {
  if (active.value && NO_BANNER_SECTIONS.includes(active.value)) return 'none';
  return providers.bannerKind;
});
/** Nous cannot be connected from here: the banner's action opens System instead. */
const bannerToSystem = computed(
  () => banner.value === 'no-key' || (banner.value !== 'none' && providers.nousManualOnly),
);
const bannerActionLabel = computed(() => {
  if (banner.value === 'no-key') return 'How to add it';
  if (providers.nousManualOnly) return 'Open System';
  return banner.value === 'renewal' ? 'Reconnect' : 'Connect';
});
const pausedLine = computed(() => {
  const n = providers.pausedCount;
  if (n === 1) return '1 experiment is paused.';
  if (n > 1) return `${n} experiments are paused.`;
  return 'Experiments that use it cannot run.';
});

/**
 * The pill hides while ConnectDialog is open, so the dialog cannot hand focus back to it:
 * when the dialog closes on a login that still waits and focus fell to the page, the pill
 * that reopened it takes it again.
 */
const approvalPill = ref<{ $el: HTMLElement } | null>(null);
watch(
  () => providers.dialogOpen,
  async (open, wasOpen) => {
    if (open || !wasOpen) return;
    await nextTick();
    const active = document.activeElement;
    if (providers.approvalLeft && (!active || active === document.body)) {
      approvalPill.value?.$el.focus();
    }
  },
);

onMounted(() => {
  void providers.load();
  void system.load();
  providers.startAutoRefresh();
  system.startPolling();
});
onBeforeUnmount(() => {
  providers.stopAutoRefresh();
  system.stopPolling();
});
</script>

<template>
  <div class="flex flex-col bg-surface">
    <header
      class="flex min-h-48 flex-wrap items-center gap-x-20 gap-y-8 border-b border-border bg-surface px-20"
    >
      <RouterLink
        to="/experiments"
        class="inline-flex h-48 items-center gap-8 text-14 font-semibold text-text no-underline hover:text-text hover:no-underline"
        data-testid="brand"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" class="flex-none">
          <rect
            x="1"
            y="1"
            width="16"
            height="16"
            rx="3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="M5.5 4.5v9M12.5 4.5v9M5.5 9h7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <span>Hermes Evals</span>
      </RouterLink>
      <nav aria-label="Sections" class="flex flex-wrap gap-2">
        <RouterLink
          v-for="section in SECTIONS"
          :key="section.id"
          v-slot="{ href, navigate }"
          :to="section.to"
          custom
        >
          <a
            :class="[NAVLINK, 'h-32']"
            :href="href"
            :aria-current="active === section.id ? 'page' : undefined"
            @click="navigate"
            >{{ section.label }}</a
          >
        </RouterLink>
      </nav>
      <div class="flex-1" />
      <div class="flex flex-wrap items-center gap-8" data-testid="status-zone">
        <ApprovalPill
          v-if="providers.approvalLeft"
          ref="approvalPill"
          :left="providers.approvalLeft"
          @open="providers.openDialog()"
        />
        <RouterLink
          v-if="showReconnecting"
          to="/experiments"
          :class="AMBER_PILL"
          title="The live stream dropped; values are frozen at the last update and will catch up on reconnect"
          data-testid="reconnecting-pill"
        >
          <StatusDot tone="ung" mode="hollow" />
          <span>{{ running.count }} running</span>{{ ' ' }}<span aria-hidden="true">·</span>{{ ' '
          }}<span>{{ reconnectText }}</span
          ><template v-if="system.lastUpdateAt"
            >{{ ' ' }}<span aria-hidden="true">·</span>{{ ' '
            }}<span class="font-mono"
              >last update {{ formatClock(system.lastUpdateAt) }}</span
            ></template
          >
        </RouterLink>
        <span
          v-if="offline"
          :class="OFFLINE_PILL"
          title="The live stream is offline; values are frozen at the last update"
          data-testid="offline-pill"
        >
          <StatusDot tone="fail" />
          <template v-if="running.count > 0"
            ><span>{{ running.count }} running</span>{{ ' ' }}<span aria-hidden="true">·</span
            >{{ ' ' }}</template
          ><span>Offline</span
          ><template v-if="system.lastUpdateAt"
            >{{ ' ' }}<span aria-hidden="true">·</span>{{ ' '
            }}<span class="font-mono"
              >last update {{ formatClock(system.lastUpdateAt) }}</span
            ></template
          >{{ ' '
          }}<button type="button" class="linkbtn text-12" @click="system.retryLive()">Retry</button>
        </span>
        <RouterLink
          v-if="showLive"
          to="/experiments"
          :class="[PILL, 'border border-border text-text-2 hover:bg-surface-2 hover:text-text']"
          :title="system.runningTitle"
          data-testid="live-pill"
        >
          <StatusDot tone="run" mode="pulse" />
          <span>{{ running.count }} running</span>{{ ' '
          }}<span class="text-text-3" aria-hidden="true">·</span>{{ ' '
          }}<span class="font-mono">{{ running.scored }} / {{ running.total }} scored</span>
        </RouterLink>
        <RouterLink
          v-if="showNoWorker"
          :to="noWorkerTo"
          :class="AMBER_PILL"
          title="No worker is connected; queued runs will not start"
          data-testid="no-worker-pill"
        >
          <StatusDot tone="ung" mode="hollow" />
          <span>{{ running.count }} running</span>{{ ' ' }}<span aria-hidden="true">·</span>{{ ' '
          }}<span>no worker</span>
        </RouterLink>
        <span class="mx-4 h-20 w-1 bg-border-strong" aria-hidden="true" />
        <RouterLink v-slot="{ href, navigate }" to="/system" custom>
          <a
            :class="[NAVLINK, 'h-28 text-12']"
            :href="href"
            :aria-current="active === 'system' ? 'page' : undefined"
            :title="systemTitle"
            :data-attention="attention ? 'true' : 'false'"
            data-testid="system-link"
            @click="navigate"
          >
            <span
              class="size-7 flex-none rounded-full"
              :class="attention ? 'bg-ung ring-2 ring-ung-soft' : 'border-[1.5px] border-text-3'"
              aria-hidden="true"
            />System<span v-if="attention" class="sr-only">, needs attention</span>
          </a>
        </RouterLink>
        <button
          type="button"
          class="inline-flex h-28 items-center justify-center gap-6 rounded-4 border border-transparent bg-transparent px-8 text-12 text-text-2 hover:bg-surface-2 hover:text-text"
          :aria-label="themeLabel"
          :title="themeLabel"
          data-testid="theme-toggle"
          @click="theme.toggle()"
        >
          <svg v-if="isDark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path
              d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>
          <span>{{ isDark ? 'Light' : 'Dark' }}</span>
        </button>
      </div>
    </header>
    <div
      v-if="banner !== 'none'"
      class="flex flex-wrap items-center gap-x-14 gap-y-10 border-b border-ung bg-ung-soft px-20 py-8"
      role="status"
      :data-banner="banner"
      data-testid="provider-banner"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
        class="flex-none text-ung-text"
      >
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
      </svg>
      <span class="text-text" data-testid="banner-text">
        <template v-if="banner === 'renewal'">
          <b class="text-ung-text" data-testid="banner-lead"
            >Your Nous Portal login needs renewing.</b
          >
          {{ pausedLine }}
        </template>
        <template v-else-if="banner === 'no-key'">
          <b class="text-ung-text" data-testid="banner-lead"
            >{{ providers.missingKeyProvider?.name ?? 'A provider' }} has no API key.</b
          >
          Experiments that use it cannot run.
        </template>
        <template v-else>
          <b class="text-ung-text" data-testid="banner-lead">Nous Portal is not connected.</b>
          Experiments that use it cannot run.
        </template>
      </span>
      <RouterLink
        v-if="bannerToSystem && active !== 'system'"
        to="/system"
        :class="BANNER_ACTION"
        data-testid="banner-action"
        >{{ bannerActionLabel }}</RouterLink
      >
      <button
        v-else-if="!bannerToSystem"
        type="button"
        :class="BANNER_ACTION"
        data-testid="banner-action"
        @click="providers.connect('other')"
      >
        {{ bannerActionLabel }}
      </button>
    </div>
  </div>
</template>
