<script setup lang="ts">
import { computed } from 'vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import { useProvidersStore } from '@/stores/providers';

/**
 * The inline notice under a configuration's Provider field. A configuration is only a
 * definition, so Save is never blocked by it. Without `status` it follows the providers store.
 */
type ProviderNoticeStatus = 'not-connected' | 'connected' | 'renewal' | 'missing';

const props = withDefaults(
  defineProps<{
    /** The provider selected in the field: 'nous', 'openrouter', … */
    provider?: string;
    status?: ProviderNoticeStatus | null;
  }>(),
  { provider: 'nous', status: null },
);
const emit = defineEmits<{ connect: [] }>();
const providers = useProvidersStore();

const info = computed(() => providers.providers.find((p) => p.id === props.provider) ?? null);

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
  <div v-if="effective === 'connected'" class="pn-connected">
    <StatusChip kind="provider" status="connected">Connected</StatusChip>
  </div>
  <div v-else-if="effective" class="pn" role="status" :data-status="effective">
    <span
      class="dot tone-ung pn-dot"
      :class="{ hollow: effective !== 'renewal' }"
      aria-hidden="true"
    />
    <span class="pn-text">
      <template v-if="effective === 'renewal'">
        <b class="pn-lead">Login needs renewing.</b>
        {{ ' ' }}<span class="t2">Experiments that use it are paused.</span>
        {{ ' ' }}<button type="button" class="linkbtn" @click="connect">Reconnect</button>
      </template>
      <template v-else-if="effective === 'missing'">
        <b class="pn-lead">Not configured.</b>
        {{ ' ' }}<span class="t2"
          >Add <code>{{ info?.envVar ?? 'the API key' }}=…</code> to <code>.env</code>, then run
          <code>{{ info?.applyCommand ?? 'docker compose up -d egress worker' }}</code
          >.</span
        >
      </template>
      <template v-else>
        <b class="pn-lead">Not connected.</b>
        {{ ' ' }}<span class="t2"
          >You can save this configuration now and connect before you launch.</span
        >
        {{ ' ' }}<button type="button" class="linkbtn" @click="connect">Connect now</button>
      </template>
    </span>
  </div>
</template>

<style scoped>
.pn {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--ung-soft);
  border: 1px solid var(--ung);
}
.pn-dot {
  margin-top: 7px;
}
.pn-dot.hollow {
  margin-top: 6px;
}
.pn-text {
  font-size: 12px;
  line-height: 18px;
}
.pn-lead {
  color: var(--ung-text);
}
.pn .linkbtn {
  font-size: 12px;
}
</style>
