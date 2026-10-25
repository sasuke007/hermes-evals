<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import ConfirmInline from '@/components/ui/ConfirmInline.vue';
import CopyButton from '@/components/ui/CopyButton.vue';
import CopyCommand from '@/components/ui/CopyCommand.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { ProviderInfo, ProviderStatus } from '@/api/types/system';
import { useProvidersStore } from '@/stores/providers';
import { NOUS_TERMINAL_LOGIN_COMMAND } from './nousCommands';

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

type ActionKind = 'connect' | 'open' | 'cancel' | 'disconnect' | 'billing' | 'reveal' | 'hide';
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
  host: "Using this machine's Hermes login (development). Set by `NOUS_HOST_PROXY` in `.env`.",
  host_unreachable:
    "This stack uses this machine's Hermes login, but its proxy is not running. Start it in a terminal:",
  unavailable:
    'The login service failed its startup check: this Hermes version does not offer the device login the platform uses.',
};

const revealed = ref(false);
/** A long command wraps inside the cell instead of widening the table (ModelAccessStates). */
const WRAP_COMMAND = '[&_code]:whitespace-normal [&_code]:wrap-anywhere';

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
    case 'unavailable':
      // ModelAccessStates: once shown, the command can be hidden again.
      return revealed.value
        ? [{ label: 'Hide command', kind: 'hide', variant: 'ghost' }]
        : [{ label: 'Show how to connect from a terminal', kind: 'reveal', variant: 'default' }];
    default:
      return [];
  }
});
const noActionNote = computed(() =>
  status.value === 'host_unreachable' || status.value === 'unavailable'
    ? 'copy the command'
    : 'none',
);
/** The command shown under the detail: the host proxy's, or the terminal login once revealed. */
const command = computed(() => {
  if (status.value === 'host_unreachable') return props.provider.hostCommand;
  if (status.value === 'unavailable' && revealed.value) return NOUS_TERMINAL_LOGIN_COMMAND;
  return null;
});
/** The detail with `backticked` words set in code, as the System board draws them. */
const detailParts = computed(() =>
  detail.value
    .split('`')
    .map((text, i) => ({ text, code: i % 2 === 1 }))
    .filter((part) => part.text !== ''),
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
    case 'reveal':
      revealed.value = true;
      break;
    case 'hide':
      revealed.value = false;
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
    <tr :data-provider="provider.id" :data-status="status">
      <td class="font-semibold">{{ provider.name }}</td>
      <td class="text-text-2">
        {{ authText }}<template v-if="!isNous">{{ ' ' }}<code>.env</code></template>
      </td>
      <td><StatusChip kind="provider" :status="status" /></td>
      <td>
        <template v-if="isNous">
          <span class="text-text-2"
            ><template v-for="(part, i) in detailParts" :key="i"
              ><code v-if="part.code" class="text-text">{{ part.text }}</code
              ><template v-else>{{ part.text }}</template></template
            ></span
          >
          <div v-if="command" class="mt-6">
            <CopyCommand :class="WRAP_COMMAND" :command="command" />
          </div>
        </template>
        <div v-else-if="provider.status === 'missing'" class="flex flex-col items-start gap-6">
          <span class="text-text-2"
            >Add <code>{{ provider.envVar }}=…</code> to <code>.env</code> at the repository root,
            then run <code>{{ provider.applyCommand }}</code
            >.</span
          >
          <CopyCommand v-if="provider.applyCommand" :command="provider.applyCommand" />
        </div>
        <span v-else class="text-text-2"
          >Key found in the egress environment · value not shown</span
        >
      </td>
      <td v-if="isNous">
        <div class="flex flex-wrap items-center gap-6" data-testid="psr-actions">
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
      <td v-else class="text-12 text-text-3">
        No input here: keys are never accepted or stored in the UI.
      </td>
    </tr>
    <tr v-if="confirmOpen || disconnectError" data-testid="psr-confirm-row">
      <td colspan="5" class="bg-fail-soft">
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
  <div v-else class="flex flex-col gap-6" :data-provider="provider.id" :data-status="status">
    <div
      class="grid min-h-52 grid-cols-[150px_200px_130px_minmax(0,1fr)_280px] items-center gap-12 rounded-6 border border-border bg-surface px-16 py-10"
    >
      <span class="font-semibold">{{ provider.name }}</span>
      <span class="text-text-2"
        >{{ authText }}<template v-if="!isNous">{{ ' ' }}<code>.env</code></template></span
      >
      <span><StatusChip kind="provider" :status="status" /></span>
      <span class="flex min-w-0 flex-col gap-6" data-testid="psr-detail">
        <template v-if="isNous">
          <span class="text-text-2"
            ><template v-for="(part, i) in detailParts" :key="i"
              ><code v-if="part.code" class="text-text">{{ part.text }}</code
              ><template v-else>{{ part.text }}</template></template
            ></span
          >
          <CopyCommand v-if="command" :class="['self-start', WRAP_COMMAND]" :command="command" />
        </template>
        <span v-else-if="provider.status === 'missing'" class="text-12 leading-20 text-text-2"
          >Add <code>{{ provider.envVar }}=…</code> to <code>.env</code>, then
          <code>{{ provider.applyCommand }}</code></span
        >
        <span v-else class="text-text-2"
          >Key found in the egress environment · value not shown</span
        >
      </span>
      <span class="flex flex-wrap items-center gap-6" data-testid="psr-actions">
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
        <span v-if="isNous && actions.length === 0" class="text-12 text-text-3">{{
          noActionNote
        }}</span>
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
