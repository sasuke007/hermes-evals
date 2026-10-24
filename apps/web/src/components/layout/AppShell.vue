<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import ApprovalPill from '@/components/model-access/ApprovalPill.vue';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import { useThemeStore } from '@/stores/theme';

/**
 * The 48px top bar (not a sidebar: every screen is wide tables, and width is the scarce
 * resource). Four work sections on the left; on the right the status zone: ApprovalPill
 * (while a Nous login waits with the dialog closed) · the live pill ("2 running · 127 / 300
 * scored", or amber "1 running · no worker") · divider · System with its status dot · theme
 * toggle. Under the bar, the amber banner when Nous Portal is not connected or its login needs
 * renewing; it is not shown on Suites or Resources pages, which never call a model.
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
const NO_BANNER_SECTIONS: ShellSection[] = ['suites', 'resources'];

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
const showLive = computed(() => running.value.count > 0 && !system.noWorker);
const showNoWorker = computed(() => running.value.count > 0 && system.noWorker);
const noWorkerTo = computed(() => {
  const only = running.value.experiments.length === 1 ? running.value.experiments[0] : undefined;
  return only ? `/experiments/${only.id}` : '/experiments';
});

const attention = computed(() => system.attention);
const systemTitle = computed(() =>
  attention.value
    ? 'System needs attention: a provider is not connected or the sandbox is not proven'
    : 'System: model access, sandbox and workers are healthy',
);

const banner = computed(() => {
  if (active.value && NO_BANNER_SECTIONS.includes(active.value)) return 'none';
  return providers.bannerKind;
});
const pausedLine = computed(() => {
  const n = providers.pausedCount;
  if (n === 1) return '1 experiment is paused.';
  if (n > 1) return `${n} experiments are paused.`;
  return 'Experiments that use it cannot run.';
});

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
  <div class="shell">
    <header class="bar">
      <RouterLink to="/experiments" class="brand">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" class="brand-mark">
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
      <nav aria-label="Sections" class="nav">
        <RouterLink
          v-for="section in SECTIONS"
          :key="section.id"
          v-slot="{ href, navigate }"
          :to="section.to"
          custom
        >
          <a
            class="navlink"
            :href="href"
            :aria-current="active === section.id ? 'page' : undefined"
            @click="navigate"
            >{{ section.label }}</a
          >
        </RouterLink>
      </nav>
      <div class="spacer" />
      <div class="status-zone">
        <ApprovalPill
          v-if="providers.approvalLeft"
          :left="providers.approvalLeft"
          @open="providers.openDialog()"
        />
        <RouterLink
          v-if="showLive"
          to="/experiments"
          class="pill live-pill"
          :title="system.runningTitle"
          data-testid="live-pill"
        >
          <span class="dot pulse tone-run" aria-hidden="true" />
          <span>{{ running.count }} running</span>{{ ' '
          }}<span class="t3" aria-hidden="true">·</span>{{ ' '
          }}<span class="mono">{{ running.scored }} / {{ running.total }} scored</span>
        </RouterLink>
        <RouterLink
          v-if="showNoWorker"
          :to="noWorkerTo"
          class="pill no-worker-pill"
          title="No worker is connected; queued runs will not start"
          data-testid="no-worker-pill"
        >
          <span class="dot hollow tone-ung" aria-hidden="true" />
          <span>{{ running.count }} running</span>{{ ' ' }}<span aria-hidden="true">·</span>{{ ' '
          }}<span>no worker</span>
        </RouterLink>
        <span class="divider" aria-hidden="true" />
        <RouterLink v-slot="{ href, navigate }" to="/system" custom>
          <a
            class="navlink system-link"
            :href="href"
            :aria-current="active === 'system' ? 'page' : undefined"
            :title="systemTitle"
            :data-attention="attention ? 'true' : 'false'"
            @click="navigate"
          >
            <span class="system-dot" :class="{ attention }" aria-hidden="true" />System<span
              v-if="attention"
              class="visually-hidden"
              >, needs attention</span
            >
          </a>
        </RouterLink>
        <button
          type="button"
          class="iconbtn"
          :aria-label="themeLabel"
          :title="themeLabel"
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
    <div v-if="banner !== 'none'" class="banner" role="status" :data-banner="banner">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" class="banner-icon">
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
      <span class="banner-text">
        <template v-if="banner === 'renewal'">
          <b class="banner-lead">Your Nous Portal login needs renewing.</b> {{ pausedLine }}
        </template>
        <template v-else>
          <b class="banner-lead">Nous Portal is not connected.</b> Experiments that use it cannot
          run.
        </template>
      </span>
      <button type="button" class="bannerbtn" @click="providers.connect('other')">
        {{ banner === 'renewal' ? 'Reconnect' : 'Connect' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  background: var(--surface);
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 20px;
  min-height: 48px;
  padding: 0 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  color: var(--text);
  font-weight: 600;
  font-size: 14px;
  text-decoration: none;
}
.brand:hover {
  color: var(--text);
  text-decoration: none;
}
.brand-mark {
  flex: none;
}
.nav {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.spacer {
  flex: 1 1 0;
}
.status-zone {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-radius: 4px;
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
}
.pill:hover {
  text-decoration: none;
}
.live-pill {
  border: 1px solid var(--border);
  color: var(--text-2);
}
.live-pill:hover {
  color: var(--text);
  background: var(--surface-2);
}
.no-worker-pill {
  border: 1px solid var(--ung);
  background: var(--ung-soft);
  color: var(--ung-text);
  font-weight: 500;
}
.no-worker-pill:hover {
  color: var(--ung-text);
}
.divider {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--border-strong);
}
.system-link {
  height: 28px;
  font-size: 12px;
}
.system-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  border: 1.5px solid var(--text-3);
}
.system-dot.attention {
  border: 0;
  background: var(--ung);
  box-shadow: 0 0 0 2px var(--ung-soft);
}
.banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 8px 20px;
  background: var(--ung-soft);
  border-bottom: 1px solid var(--ung);
}
.banner-icon {
  flex: none;
  color: var(--ung-text);
}
.banner-text {
  color: var(--text);
}
.banner-lead {
  color: var(--ung-text);
}
</style>
