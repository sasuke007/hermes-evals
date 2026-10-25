import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import IntervalBar from '@/components/ui/IntervalBar.vue';

const bar = (props: Record<string, unknown>) =>
  mount(IntervalBar, { props: props as { lo: number; hi: number; point: number } });
const left = (style: string | undefined) => Number(/left: ([\d.]+)%/.exec(style ?? '')?.[1]);
const width = (style: string | undefined) => Number(/width: ([\d.]+)%/.exec(style ?? '')?.[1]);

describe('IntervalBar', () => {
  it('says the interval in words', () => {
    const better = bar({ lo: 0.117, hi: 0.333, point: 0.217 });
    expect(better.attributes('role')).toBe('img');
    expect(better.attributes('aria-label')).toBe(
      'Difference +0.217, 95% interval +0.117 to +0.333, entirely above zero',
    );
    expect(bar({ lo: -0.083, hi: 0.194, point: 0.056 }).attributes('aria-label')).toBe(
      'Difference +0.056, 95% interval −0.083 to +0.194, crosses zero',
    );
    expect(bar({ lo: -0.267, hi: -0.033, point: -0.15 }).attributes('aria-label')).toContain(
      'entirely below zero',
    );
  });

  it('centres zero on a symmetric domain of at least ±0.2, rounded up to 0.2', () => {
    expect(bar({ lo: 0.117, hi: 0.333, point: 0.217 }).attributes('data-domain')).toBe('0.4');
    expect(bar({ lo: -0.05, hi: 0.1, point: 0.02 }).attributes('data-domain')).toBe('0.2');
    expect(bar({ lo: -0.111, hi: 0.25, point: 0.056 }).attributes('data-domain')).toBe('0.4');
    expect(bar({ lo: -0.5, hi: 0.3, point: 0 }).attributes('data-domain')).toBe('0.6');
    expect(bar({ lo: -0.9, hi: 0.1, point: -0.4 }).attributes('data-domain')).toBe('1');
    expect(bar({ lo: 0, hi: 0.3, point: 0.1, domain: 1 }).attributes('data-domain')).toBe('1');
  });

  it('labels the quarter ticks with their true values (no ±0.15 axis read as ±0.1)', () => {
    // The MCP smoke test's interval: the old rule gave ±0.3, ticks at ±0.15 labelled ±0.1.
    const w = bar({ lo: -0.111, hi: 0.25, point: 0.056 });
    expect(w.findAll('.font-mono').map((t) => t.text())).toEqual([
      '−0.4',
      '−0.2',
      '0',
      '+0.2',
      '+0.4',
    ]);
    // −0.111 sits right of the −0.2 tick (25 %): (0.4 − 0.111) / 0.8 = 36.1 %.
    expect(left(w.get('[data-testid="interval-bar"]').attributes('style'))).toBeCloseTo(36.13, 1);
    expect(
      bar({ lo: -0.5, hi: 0.3, point: 0 })
        .findAll('.font-mono')
        .map((t) => t.text()),
    ).toEqual(['−0.6', '−0.3', '0', '+0.3', '+0.6']);
  });

  it('places the bar and the point on that domain', () => {
    const w = bar({ lo: 0.117, hi: 0.333, point: 0.217 });
    const b = w.get('[data-testid="interval-bar"]').attributes('style');
    // (0.117 + 0.4) / 0.8 = 64.6 %; (0.333 + 0.4) / 0.8 = 91.6 %.
    expect(left(b)).toBeCloseTo(64.63, 1);
    expect(width(b)).toBeCloseTo(27, 1);
    expect(left(w.get('[data-testid="interval-point"]').attributes('style'))).toBeCloseTo(77.13, 1);
  });

  it('takes its tone from the verdict, else from the interval', () => {
    expect(bar({ lo: 0.1, hi: 0.3, point: 0.2 }).attributes('data-tone')).toBe('pass');
    expect(bar({ lo: -0.3, hi: -0.1, point: -0.2 }).attributes('data-tone')).toBe('fail');
    expect(bar({ lo: -0.1, hi: 0.3, point: 0.1 }).attributes('data-tone')).toBe('que');
    const prov = bar({ lo: -0.09, hi: 0.196, point: 0.053, verdict: 'provisional' });
    expect(prov.attributes('data-tone')).toBe('provisional');
    expect(prov.get('[data-testid="interval-bar"]').classes()).toContain('border-dashed');
    expect(
      bar({ lo: -0.1, hi: 0.3, point: 0.1, verdict: 'inconclusive' })
        .get('[data-testid="interval-bar"]')
        .classes(),
    ).toEqual(expect.arrayContaining(['bg-que-soft', 'inset-ring-que']));
  });

  it('labels five ticks at md and three at sm', () => {
    const md = bar({ lo: 0.117, hi: 0.333, point: 0.217 });
    expect(md.findAll('.font-mono').map((t) => t.text())).toEqual([
      '−0.4',
      '−0.2',
      '0',
      '+0.2',
      '+0.4',
    ]);
    const sm = bar({ lo: 0.117, hi: 0.333, point: 0.217, size: 'sm' });
    expect(sm.findAll('.font-mono').map((t) => t.text())).toEqual(['−0.4', '0', '+0.4']);
    expect(sm.attributes('style')).toContain('height: 34px');
  });
});
