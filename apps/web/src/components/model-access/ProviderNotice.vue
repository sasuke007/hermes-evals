<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import CopyButton from '@/components/ui/CopyButton.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import { useProvidersStore } from '@/stores/providers';

/**
 * The inline notice under a configuration's Provider field. A configuration is only a
 * definition, so Save is never blocked by it. Without `status` it follows the providers store.
 * `missing` (an API-key provider without a key, ConfigForm board): no Connect, the server step
 * with Copy and a link to System, because keys are never typed in the app.
 */
type ProviderNoticeStatus = 'not-connected' | 'connected' | 'renewal' | 'missing';

const props = withDefaults(
  defineProps<{
    /** The provider selected in the field: 'nous', 'openrouter', … */
    provider?: string;
    status?: ProviderNoticeStatus | null;
    /** missing: "See System › Model access". */
    systemTo?: RouteLocationRaw;
  }>(),
  { provider: 'nous', status: null, systemTo: '/system' },
);
const emit = defineEmits<{ connect: [] }>();
const providers = useProvidersStore();

const info = computed(() => providers.providers.find((p) => p.id === props.provider) ?? null);
const envVar = computed(() => info.value?.envVar ?? 'OPENROUTER_API_KEY');
const applyCommand = computed(
  () => info.value?.applyCommand ?? 'docker compose up -d egress worker',
);

const effective = computed<ProviderNoticeStatus | null>(() => {
  if (props.status) return props.status;
  if (props.provider === 'nous') {
    if (!providers.loaded) return null;
    if (providers.nousConnected) return 'connected';
    return providers.nousStatus === 'relogin_required' ? 'renewal' : 'not-connected';
  }
  if (!info.value) return null;
  return info.value.status === 'configured' ? 'connected' : 'missing';
});

function connect(): void {
  emit('connect');
  void providers.connect('other');
}
</script>

<template>
  <div v-if="effective === 'connected'">
    <StatusChip kind="provider" status="connected">Connected</StatusChip>
  </div>
  <div
    v-else-if="effective"
    class="flex items-start gap-8 rounded-4 border border-ung bg-ung-soft px-10 py-8"
    role="status"
    :data-status="effective"
  >
    <StatusDot
      tone="ung"
      :mode="effective === 'renewal' ? 'solid' : 'hollow'"
      :class="effective === 'renewal' ? 'mt-7' : 'mt-6'"
    />
    <span
      class="min-w-0 text-12 leading-18"
      :class="{ 'flex flex-col gap-6': effective === 'missing' }"
    >
      <template v-if="effective === 'renewal'">
        <b class="text-ung-text">Login needs renewing.</b>
        {{ ' ' }}<span class="text-text-2">Experiments that use it are paused.</span> {{ ' '
        }}<button type="button" class="linkbtn text-12" @click="connect">Reconnect</button>
      </template>
      <template v-else-if="effective === 'missing'">
        <span
          ><b class="text-ung-text">No API key.</b> {{ ' '
          }}<span class="text-text-2"
            ><code>{{ envVar }}</code> is not set on the server. You can save this configuration now
            and add the key before you launch.</span
          ></span
        >
        <span class="flex items-start gap-8">
          <span class="min-w-0 flex-1 text-text-2"
            >Add <code>{{ envVar }}=…</code> to <code>.env</code>, then run
            <code>{{ applyCommand }}</code></span
          >
          <CopyButton
            class="h-26"
            variant="button"
            :text="applyCommand"
            label="Copy the command"
            button-text="Copy"
          />
        </span>
        <RouterLink :to="systemTo" class="self-start">See System › Model access</RouterLink>
      </template>
      <template v-else>
        <b class="text-ung-text">Not connected.</b>
        {{ ' '
        }}<span class="text-text-2"
          >You can save this configuration now and connect before you launch.</span
        >
        {{ ' ' }}<button type="button" class="linkbtn text-12" @click="connect">Connect now</button>
      </template>
    </span>
  </div>
</template>
