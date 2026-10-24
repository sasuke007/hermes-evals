<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import ConfirmInline from '@/components/ui/ConfirmInline.vue';
import CopyButton from '@/components/ui/CopyButton.vue';
import CopyCommand from '@/components/ui/CopyCommand.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { ProviderInfo, ProviderStatus } from '@/api/types/system';
import { useProvidersStore } from '@/stores/providers';

/**
 * One provider on System › Model access. It never contains an input for a key or a token.
 * layout="table" renders <tr> rows for the System table (Provider · Authenticates with ·
 * Status · Detail · Action; use inside <tbody>); layout="grid" renders the standalone .psr row
 * (ModelAccessStates, Components 3). Actions drive the providers store: Connect, Reconnect,
 * Get a new code and Try again open ConnectDialog; Disconnect asks first with ConfirmInline.
 */
const props = withDefaults(
  defineProps<{
    provider: ProviderInfo;
    layout?: 'table' | 'grid';
  }>(),
  { layout: 'grid' },
);

type ActionKind = 'connect' | 'open' | 'cancel' | 'disconnect' | 'billing';
interface RowAction {
  label: string;
  kind: ActionKind;
  variant: 'primary' | 'default' | 'ghost';
}

const providers = useProvidersStore();
const isNous = computed(() => props.provider.authMethod === 'oauth-device');
const status = computed<ProviderStatus>(() =>
  isNous.value && props.provider.id === 'nous' ? providers.nousStatus : props.provider.status,
);

const authText = computed(() =>
  isNous.value ? `Sign-in with ${props.provider.name}` : 'API key in',
);

const NOUS_DETAIL: Partial<Record<ProviderStatus, string>> = {
  not_connected: 'Connect once; every experiment that uses Nous Portal can then run.',
  relogin_required:
    'Nous Portal ended this login. Experiments that use it are paused until you reconnect.',
  expired: 'The code expired before it was approved.',
  denied: 'The login was declined in Nous Portal.',
  needs_subscription: 'This Nous account has no active subscription.',
  host: "Using this machine's Hermes login (development). Set by NOUS_HOST_PROXY in .env.",
  host_unreachable:
    "This stack uses this machine's Hermes login, but its proxy is not running. Start it in a terminal:",
};

const detail = computed(() => {
  switch (status.value) {
    case 'waiting_for_approval':
      return `Code ${providers.userCode ?? props.provider.login?.userCode ?? ''} · ${providers.countdown} left`;
    case 'connected':
      return `Signed in · scope ${props.provider.scope ?? 'inference'}`;
    case 'failed':
      return (
        providers.loginError ??
        props.provider.login?.error ??
        'Could not reach Nous Portal: connection timed out.'
      );
    default:
      return NOUS_DETAIL[status.value] ?? '';
  }
});

const actions = computed<RowAction[]>(() => {
  if (!isNous.value) return [];
  switch (status.value) {
    case 'not_connected':
      return [{ label: `Connect ${props.provider.name}`, kind: 'connect', variant: 'primary' }];
    case 'waiting_for_approval':
      return [
        { label: 'Open dialog', kind: 'open', variant: 'primary' },
        { label: 'Cancel', kind: 'cancel', variant: 'ghost' },
      ];
    case 'connected':
      return [{ label: 'Disconnect', kind: 'disconnect', variant: 'default' }];
    case 'relogin_required':
      return [{ label: 'Reconnect', kind: 'connect', variant: 'primary' }];
    case 'expired':
      return [{ label: 'Get a new code', kind: 'connect', variant: 'default' }];
    case 'denied':
    case 'failed':
      return [{ label: 'Try again', kind: 'connect', variant: 'default' }];
    case 'needs_subscription':
      return [{ label: 'Open Nous Portal billing ↗', kind: 'billing', variant: 'default' }];
    default:
      return [];
  }
});
const noActionNote = computed(() =>
  status.value === 'host_unreachable' ? 'copy the command' : 'none',
);

const billingHref = computed(
  () =>
    providers.billingUrl ?? props.provider.billingUrl ?? props.provider.login?.billingUrl ?? '#',
);

// ── Disconnect, confirmed inline ──────────────────────────────────────────
const confirmOpen = ref(false);
const disconnecting = ref(false);
const disconnectError = ref<string | null>(null);
const disconnectBtn = ref<HTMLButtonElement[] | HTMLButtonElement | null>(null);

function focusDisconnect(): void {
  const el = Array.isArray(disconnectBtn.value) ? disconnectBtn.value[0] : disconnectBtn.value;
  el?.focus();
}

async function run(action: RowAction): Promise<void> {
  switch (action.kind) {
    case 'connect':
      await providers.connect('other');
      break;
    case 'open':
      await providers.openDialog();
      break;
    case 'cancel':
      await providers.cancel();
      break;
    case 'disconnect':
      disconnectError.value = null;
      confirmOpen.value = true;
      break;
    default:
      break;
  }
}

async function confirmDisconnect(): Promise<void> {
  disconnecting.value = true;
  disconnectError.value = null;
  try {
    await providers.disconnect();
  } catch (err) {
    disconnectError.value = err instanceof Error ? err.message : String(err);
  } finally {
    disconnecting.value = false;
  }
}

async function keepConnected(): Promise<void> {
  await nextTick();
  focusDisconnect();
}

function btnClass(action: RowAction): string[] {
  return ['btn', 'mid', action.variant === 'default' ? '' : action.variant];
}
</script>

<template>
  <!-- System › Model access table -->
  <template v-if="layout === 'table'">
    <tr class="psr-row" :data-provider="provider.id" :data-status="status">
      <td class="psr-name">{{ provider.name }}</td>
      <td class="t2">
        {{ authText }}<template v-if="!isNous"> <code>.env</code></template>
      </td>
      <td><StatusChip kind="provider" :status="status" /></td>
      <td>
        <template v-if="isNous">
          <span class="t2">{{ detail }}</span>
          <div v-if="status === 'host_unreachable' && provider.hostCommand" class="psr-cmd">
            <CopyCommand :command="provider.hostCommand" />
          </div>
        </template>
        <div v-else-if="provider.status === 'missing'" class="psr-key">
          <span class="t2"
            >Add <code>{{ provider.envVar }}=…</code> to <code>.env</code> at the repository root,
            then run <code>{{ provider.applyCommand }}</code
            >.</span
          >
          <CopyCommand v-if="provider.applyCommand" :command="provider.applyCommand" />
        </div>
        <span v-else class="t2">Key found in the egress environment · value not shown</span>
      </td>
      <td v-if="isNous">
        <div class="psr-actions">
          <template v-for="action in actions" :key="action.label">
            <a
              v-if="action.kind === 'billing'"
              :class="btnClass(action)"
              :href="billingHref"
              target="_blank"
              rel="noopener noreferrer"
              title="Opens Nous Portal billing in a new tab"
              >{{ action.label }}</a
            >
            <button
              v-else-if="action.kind === 'disconnect'"
              ref="disconnectBtn"
              type="button"
              :class="btnClass(action)"
              :aria-expanded="confirmOpen ? 'true' : 'false'"
              @click="run(action)"
            >
              {{ action.label }}
            </button>
            <button v-else type="button" :class="btnClass(action)" @click="run(action)">
              {{ action.label }}
            </button>
          </template>
        </div>
      </td>
      <td v-else class="cap">No input here: keys are never accepted or stored in the UI.</td>
    </tr>
    <tr v-if="confirmOpen || disconnectError" class="psr-confirm-row">
      <td colspan="5">
        <ConfirmInline
          v-model:open="confirmOpen"
          title="Disconnect Nous Portal?"
          consequence="Running experiments that use it will pause."
          confirm-label="Disconnect"
          cancel-label="Keep connected"
          busy-label="Disconnecting…"
          label="Confirm disconnect"
          layout="row"
          button-size="mid"
          bare
          :busy="disconnecting"
          :error="disconnectError"
          error-title="Could not disconnect Nous Portal"
          @confirm="confirmDisconnect"
          @cancel="keepConnected"
        />
      </td>
    </tr>
  </template>

  <!-- Standalone row (ModelAccessStates, Components 3) -->
  <div v-else class="psr-wrap" :data-provider="provider.id" :data-status="status">
    <div class="psr">
      <span class="psr-name">{{ provider.name }}</span>
      <span class="t2"
        >{{ authText }}<template v-if="!isNous"> <code>.env</code></template></span
      >
      <span><StatusChip kind="provider" :status="status" /></span>
      <span class="psr-detail">
        <template v-if="isNous">
          <span class="t2">{{ detail }}</span>
          <CopyCommand
            v-if="status === 'host_unreachable' && provider.hostCommand"
            class="psr-cmd-inline"
            :command="provider.hostCommand"
          />
        </template>
        <span v-else-if="provider.status === 'missing'" class="t2 psr-small"
          >Add <code>{{ provider.envVar }}=…</code> to <code>.env</code>, then
          <code>{{ provider.applyCommand }}</code></span
        >
        <span v-else class="t2">Key found in the egress environment · value not shown</span>
      </span>
      <span class="psr-actions">
        <template v-for="action in actions" :key="action.label">
          <a
            v-if="action.kind === 'billing'"
            :class="btnClass(action)"
            :href="billingHref"
            target="_blank"
            rel="noopener noreferrer"
            title="Opens Nous Portal billing in a new tab"
            >{{ action.label }}</a
          >
          <button
            v-else-if="action.kind === 'disconnect'"
            ref="disconnectBtn"
            type="button"
            :class="btnClass(action)"
            :aria-expanded="confirmOpen ? 'true' : 'false'"
            @click="run(action)"
          >
            {{ action.label }}
          </button>
          <button v-else type="button" :class="btnClass(action)" @click="run(action)">
            {{ action.label }}
          </button>
        </template>
        <CopyButton
          v-if="!isNous && provider.status === 'missing' && provider.applyCommand"
          variant="button"
          :text="provider.applyCommand"
          label="Copy command"
          button-text="Copy command"
        />
        <span v-if="isNous && actions.length === 0" class="cap">{{ noActionNote }}</span>
      </span>
    </div>
    <ConfirmInline
      v-model:open="confirmOpen"
      title="Disconnect Nous Portal?"
      consequence="Running experiments that use it will pause."
      confirm-label="Disconnect"
      cancel-label="Keep connected"
      busy-label="Disconnecting…"
      label="Confirm disconnect"
      layout="row"
      button-size="mid"
      :busy="disconnecting"
      :error="disconnectError"
      error-title="Could not disconnect Nous Portal"
      @confirm="confirmDisconnect"
      @cancel="keepConnected"
    />
  </div>
</template>

<style scoped>
.psr-name {
  font-weight: 600;
}
.psr-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.psr-cmd {
  margin-top: 6px;
}
.psr-key {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.psr-confirm-row td {
  background: var(--fail-soft);
}
.psr-confirm-row:hover td {
  background: var(--fail-soft);
}
.psr-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.psr-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.psr-cmd-inline {
  align-self: flex-start;
}
.psr-small {
  font-size: 12px;
}
</style>
