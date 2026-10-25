import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { usePolling } from '@/composables/usePolling';
import { setVisibility } from '@/stores/__tests__/scenarioEnv';

let scope = effectScope();
beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
  scope = effectScope();
});
afterEach(() => {
  scope.stop();
  vi.useRealTimers();
});

const poll = (...args: Parameters<typeof usePolling>) => scope.run(() => usePolling(...args))!;

describe('usePolling', () => {
  it('calls every interval while enabled', async () => {
    const fn = vi.fn<() => void>();
    poll(fn, 5_000);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls at once with immediate', async () => {
    const fn = vi.fn<() => void>();
    poll(fn, 5_000, true, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops while disabled and starts again when enabled', async () => {
    const fn = vi.fn<() => void>();
    const enabled = ref(false);
    poll(fn, 1_000, enabled);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fn).not.toHaveBeenCalled();
    enabled.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(1);
    enabled.value = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never overlaps: the next call waits for the previous one', async () => {
    let finish: () => void = () => {};
    const fn = vi.fn<() => Promise<void>>(() => new Promise<void>((resolve) => (finish = resolve)));
    const { pending } = poll(fn, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pending.value).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps polling after a failure and exposes it', async () => {
    const fn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValue(undefined);
    const { error } = poll(fn, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((error.value as Error).message).toBe('502');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(error.value).toBeNull();
  });

  it('pauses while the tab is hidden and calls at once when it is visible again', async () => {
    const fn = vi.fn<() => void>();
    poll(fn, 1_000);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).not.toHaveBeenCalled();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops when its scope is disposed', async () => {
    const fn = vi.fn<() => void>();
    poll(fn, 1_000);
    scope.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fn).not.toHaveBeenCalled();
  });
});
