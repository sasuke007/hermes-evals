import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import StatusChip from '@/components/ui/StatusChip.vue';
import { STATUS_TONES, statusTone, type StatusKind } from '@/lib/statusTones';

function chip(props: Record<string, unknown>, slot?: string) {
  return mount(StatusChip, {
    props: props as { status: string; kind: StatusKind },
    slots: slot ? { default: slot } : {},
  });
}

describe('status tone table', () => {
  it.each([
    ['score', 'passed', 'pass', 'solid'],
    ['score', 'failed', 'fail', 'solid'],
    ['score', 'error', 'err', 'solid'],
    ['score', 'ungradable', 'ung', 'solid'],
    ['run', 'queued', 'que', 'hollow'],
    ['run', 'running', 'run', 'pulse'],
    ['run', 'executed', 'run', 'hollow'],
    ['run', 'scoring', 'run', 'pulse'],
    ['run', 'scored', 'que', 'solid'],
    ['run', 'execution_error', 'err', 'solid'],
    ['run', 'cancelled', 'que', 'hollow'],
    ['experiment', 'running', 'run', 'pulse'],
    ['experiment', 'paused', 'que', 'hollow'],
    ['experiment', 'completed', 'que', 'solid'],
    ['experiment', 'failed', 'err', 'solid'],
    ['verdict', 'better', 'pass', 'solid'],
    ['verdict', 'worse', 'fail', 'solid'],
    ['verdict', 'inconclusive', 'que', 'hollow'],
    ['provider', 'not_connected', 'que', 'hollow'],
    ['provider', 'waiting_for_approval', 'run', 'pulse'],
    ['provider', 'connected', 'pass', 'solid'],
    ['provider', 'relogin_required', 'ung', 'solid'],
    ['provider', 'expired', 'que', 'hollow'],
    ['provider', 'denied', 'que', 'hollow'],
    ['provider', 'needs_subscription', 'ung', 'solid'],
    ['provider', 'failed', 'fail', 'solid'],
    ['provider', 'host', 'run', 'solid'],
    ['provider', 'host_unreachable', 'ung', 'hollow'],
    ['provider', 'configured', 'pass', 'solid'],
    ['provider', 'missing', 'que', 'hollow'],
    ['pauseReason', 'provider_disconnected', 'ung', 'solid'],
    ['pauseReason', 'spend_ceiling', 'que', 'none'],
    ['pauseReason', 'user', 'que', 'none'],
    ['sandbox', 'proven', 'pass', 'solid'],
    ['sandbox', 'not_proven', 'fail', 'solid'],
    ['worker', 'online', 'pass', 'solid'],
    ['worker', 'offline', 'fail', 'solid'],
  ] as const)('%s %s → %s, %s dot', (kind, status, tone, dot) => {
    expect(statusTone(kind, status)).toMatchObject({ tone, dot });
  });

  it('uses the drawn provider words, and accepts them as values', () => {
    const labels = Object.values(STATUS_TONES.provider).map((t) => t.label);
    expect(labels).toEqual([
      'not connected',
      'waiting',
      'connected',
      'reconnect',
      'expired',
      'declined',
      'subscription',
      'error',
      'this machine',
      'not running',
      'configured',
      'missing',
    ]);
    expect(statusTone('provider', 'not connected').tone).toBe('que');
    expect(statusTone('provider', 'reconnect').label).toBe('reconnect');
    expect(statusTone('provider', 'this machine').tone).toBe('run');
    expect(statusTone('pauseReason', 'provider disconnected').tone).toBe('ung');
  });

  it('keeps data-model words verbatim', () => {
    expect(statusTone('run', 'execution_error').label).toBe('execution_error');
    expect(statusTone('score', 'ungradable').label).toBe('ungradable');
  });

  it('separates groups that share a word', () => {
    expect(statusTone('score', 'failed').tone).toBe('fail');
    expect(statusTone('experiment', 'failed').tone).toBe('err');
    expect(statusTone('score', 'error').tone).toBe('err');
    expect(statusTone('provider', 'error').tone).toBe('fail');
  });

  it('turns a provider-disconnected pause amber with a square dot', () => {
    expect(statusTone('experiment', 'paused', { pauseReason: 'provider_disconnected' })).toEqual({
      tone: 'ung',
      dot: 'square',
      label: 'paused',
    });
    expect(statusTone('experiment', 'paused', { pauseReason: 'spend_ceiling' }).tone).toBe('que');
  });

  it('falls back to a neutral chip with the raw word', () => {
    expect(statusTone('run', 'teleported')).toEqual({
      tone: 'que',
      dot: 'solid',
      label: 'teleported',
    });
  });
});

describe('StatusChip', () => {
  it('renders the tone class, the dot and the exact word', () => {
    const w = chip({ kind: 'run', status: 'running' });
    expect(w.classes()).toContain('chip');
    expect(w.classes()).toContain('tone-run');
    expect(w.attributes('data-tone')).toBe('run');
    expect(w.find('.dot').classes()).toContain('pulse');
    expect(w.text()).toBe('running');
  });

  it('draws hollow dots for not-started values', () => {
    const dot = chip({ kind: 'run', status: 'queued' }).find('.dot');
    expect(dot.classes()).toContain('hollow');
    expect(dot.attributes('aria-hidden')).toBe('true');
  });

  it('stops pulsing when not live', () => {
    const dot = chip({ kind: 'run', status: 'scoring', live: false }).find('.dot');
    expect(dot.classes()).not.toContain('pulse');
    expect(dot.attributes('data-dot')).toBe('solid');
  });

  it('draws verdicts strong', () => {
    const w = chip({ kind: 'verdict', status: 'better' });
    expect(w.classes()).toContain('strong');
    expect(w.classes()).toContain('tone-pass');
    expect(chip({ kind: 'verdict', status: 'inconclusive' }).classes()).toContain('tone-que');
  });

  it('shows provider labels from the table', () => {
    const w = chip({ kind: 'provider', status: 'relogin_required' });
    expect(w.text()).toBe('reconnect');
    expect(w.classes()).toContain('tone-ung');
  });

  it('shows a count in mono, a small size, and can hide the dot', () => {
    const w = chip({ kind: 'score', status: 'failed', count: 3, size: 'sm', dot: false });
    expect(w.text()).toBe('failed3');
    expect(w.find('.count').classes()).toContain('mono');
    expect(w.classes()).toContain('sm');
    expect(w.find('.dot').exists()).toBe(false);
  });

  it('draws no dot for pause reasons without one', () => {
    expect(chip({ kind: 'pauseReason', status: 'spend_ceiling' }).find('.dot').exists()).toBe(
      false,
    );
    expect(chip({ kind: 'pauseReason', status: 'spend_ceiling' }).text()).toBe('spend ceiling');
  });

  it('draws the amber square dot for a provider-disconnected pause', () => {
    const w = chip({ kind: 'experiment', status: 'paused', pauseReason: 'provider_disconnected' });
    expect(w.classes()).toContain('tone-ung');
    expect(w.find('.dot').classes()).toContain('square');
  });

  it('lets a slot replace the label, keeping the tone', () => {
    const w = chip({ kind: 'verdict', status: 'better' }, 'with-skill better');
    expect(w.text()).toBe('with-skill better');
    expect(w.classes()).toContain('tone-pass');
  });
});
