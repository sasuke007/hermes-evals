import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import type { ProviderInfo } from '@/api/types/system';
import ProviderStatusRow from '@/components/model-access/ProviderStatusRow.vue';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('ProviderStatusRow: a configured API-key provider', () => {
  // The custom endpoint always reads configured (its key is optional, the mock model takes
  // none), so on a fresh clone with no .env it must not say a key was found (Phase 8).
  const keyRow = (id: 'custom' | 'openai', envVar: string): ProviderInfo => ({
    id,
    name: id === 'custom' ? 'Custom endpoint' : 'OpenAI',
    authMethod: 'env-key',
    status: 'configured',
    scope: null,
    envVar,
    applyCommand: 'docker compose up -d egress worker',
    hostCommand: null,
    billingUrl: null,
    usedBy: [],
    pausedExperiments: 0,
    login: null,
  });

  it.each(['grid', 'table'] as const)(
    '%s: the custom endpoint says its key is optional, a key provider that it was found',
    (layout) => {
      const pinia = createPinia();
      setActivePinia(pinia);
      const global = { plugins: [pinia] };
      const rows = [keyRow('custom', 'CUSTOM_API_KEY'), keyRow('openai', 'OPENAI_API_KEY')];
      const Host = defineComponent({
        setup: () => () =>
          layout === 'table'
            ? h('table', [
                h(
                  'tbody',
                  rows.map((p) => h(ProviderStatusRow, { provider: p, layout, key: p.id })),
                ),
              ])
            : h(
                'div',
                rows.map((p) => h(ProviderStatusRow, { provider: p, layout, key: p.id })),
              ),
      });
      wrapper = mount(Host, { global, attachTo: document.body });
      const detail = (id: string) =>
        wrapper!.find(`[data-provider="${id}"] [data-testid="psr-key-detail"]`).text();
      expect(detail('custom')).toBe(
        'Key optional: egress sends CUSTOM_API_KEY when .env sets it · value not shown',
      );
      expect(detail('openai')).toBe('Key found in the egress environment · value not shown');
    },
  );
});
