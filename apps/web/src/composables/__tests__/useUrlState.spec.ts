import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import {
  urlBool,
  urlEnum,
  urlList,
  urlNumber,
  urlOptional,
  urlSort,
  urlString,
  useUrlState,
} from '@/composables/useUrlState';

const params = {
  status: urlEnum(['all', 'running', 'paused'] as const, 'all'),
  q: urlString(),
  sort: urlSort({ key: 'launched', dir: 'desc' }, ['launched', 'name']),
  execError: urlBool(false),
  reps: urlNumber(5, { min: 1, max: 50, integer: true }),
  configs: urlList(),
  candidate: urlOptional(),
};

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

async function setup(path = '/experiments') {
  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: { render: () => null } }],
  });
  await router.push(path);
  await router.isReady();
  let state!: ReturnType<typeof useUrlState<typeof params>>;
  const Host = defineComponent({
    setup() {
      state = useUrlState(params);
      return () => h('div');
    },
  });
  wrapper = mount(Host, { global: { plugins: [router] } });
  return { router, state };
}

describe('useUrlState', () => {
  it('reads defaults from an empty query', async () => {
    const { state } = await setup();
    expect(state.status.value).toBe('all');
    expect(state.q.value).toBe('');
    expect(state.sort.value).toEqual({ key: 'launched', dir: 'desc' });
    expect(state.execError.value).toBe(false);
    expect(state.reps.value).toBe(5);
    expect(state.configs.value).toEqual([]);
    expect(state.candidate.value).toBeNull();
  });

  it('reads the query, and ignores values outside the codec', async () => {
    const { state } = await setup(
      '/experiments?status=paused&sort=name&execError=1&reps=900&configs=a,b&candidate=cfgv_x&q=inv',
    );
    expect(state.status.value).toBe('paused');
    expect(state.sort.value).toEqual({ key: 'name', dir: 'asc' });
    expect(state.execError.value).toBe(true);
    expect(state.reps.value).toBe(50);
    expect(state.configs.value).toEqual(['a', 'b']);
    expect(state.candidate.value).toBe('cfgv_x');
    expect(state.q.value).toBe('inv');
    const { state: other } = await setup('/x?status=teleported&sort=-bogus&reps=abc');
    expect(other.status.value).toBe('all');
    expect(other.sort.value).toEqual({ key: 'launched', dir: 'desc' });
    expect(other.reps.value).toBe(5);
  });

  it('writes to the query, merging writes in one tick, dropping defaults', async () => {
    const { router, state } = await setup('/experiments?keep=1');
    state.status.value = 'running';
    state.sort.value = { key: 'name', dir: 'desc' };
    state.execError.value = true;
    // A write is visible at once, before the navigation lands.
    expect(state.status.value).toBe('running');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({
      keep: '1',
      status: 'running',
      sort: '-name',
      execError: '1',
    });
    state.status.value = 'all';
    state.execError.value = false;
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ keep: '1', sort: '-name' });
  });

  it('replaces the history entry instead of pushing one', async () => {
    const { router, state } = await setup('/experiments');
    await router.push('/experiments?q=a');
    state.q.value = 'ab';
    await flushPromises();
    router.back();
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/experiments');
  });

  it('resets every field to its default', async () => {
    const { router, state } = await setup('/runs?status=paused&configs=a&other=x');
    state.reset();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ other: 'x' });
  });

  it('round-trips a sort turned off where the default sorts', async () => {
    const { router, state } = await setup();
    state.sort.value = null;
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ sort: '' });
    expect(state.sort.value).toBeNull();
  });
});
