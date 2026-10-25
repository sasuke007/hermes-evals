/**
 * EventTimeline and TimelineScrubber on their own: virtualising above 200 events, following
 * a live run and the "Jump to latest" pill, scrubber buckets, keyboard and seeking.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { SAMPLE_RUN_ID } from '@/fixtures/experiments';
import type { TimelineEvent } from '@/api/types/runs';
import EventTimeline from '../EventTimeline.vue';
import TimelineScrubber from '../TimelineScrubber.vue';
import { detailOf } from './inspectorEnv';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/** n tool and text events, seq 1…n. */
function events(n: number): TimelineEvent[] {
  const [, , tool, , , , , text] = detailOf(SAMPLE_RUN_ID).timeline.events;
  return Array.from({ length: n }, (_, i) => ({
    ...(i % 3 === 0 ? text! : tool!),
    seq: i + 1,
    atMs: i * 100,
    error: i === n - 1,
  }));
}

/** Give the list box a layout jsdom does not compute. */
function layout(
  el: HTMLElement,
  box: { scrollTop: number; clientHeight: number; scrollHeight: number },
) {
  for (const [key, value] of Object.entries(box)) {
    Object.defineProperty(el, key, { value, configurable: true, writable: true });
  }
}

describe('EventTimeline', () => {
  it('renders every row up to 200 events', () => {
    wrapper = mount(EventTimeline, { props: { events: events(200), open: new Set<number>() } });
    expect(wrapper.findAll('[data-testid="timeline-event"]')).toHaveLength(200);
    expect(wrapper.get('[data-testid="event-list"]').attributes('data-virtual')).toBeUndefined();
  });

  it('renders only the rows in view above 200 events', async () => {
    wrapper = mount(EventTimeline, {
      props: { events: events(1200), open: new Set<number>() },
      attachTo: document.body,
    });
    await nextTick();
    const list = wrapper.get('[data-testid="event-list"]');
    expect(list.attributes('data-virtual')).toBe('true');
    const rendered = wrapper.findAll('[data-testid="timeline-event"]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
    // The list still tells assistive technology its whole size and each row's place.
    const items = list.findAll('[role="listitem"]');
    expect(items[0]!.attributes('aria-setsize')).toBe('1200');
    expect(items[0]!.attributes('aria-posinset')).toBe('1');
    expect(items[items.length - 1]!.attributes('aria-posinset')).toBe(String(items.length));
  });

  it('counts new events on "Jump to latest" once the user has scrolled up', async () => {
    const all = events(30);
    wrapper = mount(EventTimeline, {
      props: { events: all.slice(0, 20), open: new Set<number>(), live: true },
      attachTo: document.body,
    });
    await flushPromises();
    const box = wrapper.get('[data-testid="event-list"]').element as HTMLElement;
    layout(box, { scrollTop: 0, clientHeight: 300, scrollHeight: 740 });
    await wrapper.get('[data-testid="event-list"]').trigger('scroll');
    await wrapper.setProps({ events: all.slice(0, 22) });
    await flushPromises();
    const pill = wrapper.get('[data-testid="jump-to-latest"]');
    expect(pill.text()).toBe('Jump to latest · 2 new');
    await wrapper.setProps({ events: all });
    await flushPromises();
    expect(wrapper.get('[data-testid="jump-to-latest"]').text()).toBe('Jump to latest · 10 new');
    await wrapper.get('[data-testid="jump-to-latest"]').trigger('click');
    expect(box.scrollTop).toBe(740);
    expect(wrapper.find('[data-testid="jump-to-latest"]').exists()).toBe(false);
  });

  it('follows the newest event while at the bottom', async () => {
    const all = events(30);
    wrapper = mount(EventTimeline, {
      props: { events: all.slice(0, 20), open: new Set<number>(), live: true },
      attachTo: document.body,
    });
    await flushPromises();
    const box = wrapper.get('[data-testid="event-list"]').element as HTMLElement;
    layout(box, { scrollTop: 440, clientHeight: 300, scrollHeight: 740 });
    await wrapper.get('[data-testid="event-list"]').trigger('scroll');
    layout(box, { scrollTop: 440, clientHeight: 300, scrollHeight: 1110 });
    await wrapper.setProps({ events: all });
    await flushPromises();
    expect(box.scrollTop).toBe(1110);
    expect(wrapper.find('[data-testid="jump-to-latest"]').exists()).toBe(false);
  });

  it('reports which events are in view', async () => {
    wrapper = mount(EventTimeline, {
      props: { events: events(40), open: new Set<number>() },
      attachTo: document.body,
    });
    await flushPromises();
    const box = wrapper.get('[data-testid="event-list"]').element as HTMLElement;
    layout(box, { scrollTop: 370, clientHeight: 370, scrollHeight: 1480 });
    await wrapper.get('[data-testid="event-list"]').trigger('scroll');
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const reports = wrapper.emitted('viewport') ?? [];
    expect(reports[reports.length - 1]).toEqual([{ first: 10, last: 19 }]);
  });
});

describe('TimelineScrubber', () => {
  it('draws one tick per event and seeks on click', async () => {
    const list = detailOf(SAMPLE_RUN_ID).timeline.events;
    wrapper = mount(TimelineScrubber, {
      props: { events: list, open: new Set([4]), viewport: null },
    });
    const ticks = wrapper.findAll('[data-testid="scrubber-tick"]');
    expect(ticks.map((t) => t.attributes('data-look'))).toEqual([
      'refused',
      'net',
      'tool',
      'error',
      'net',
      'tool',
      'net',
      'text',
      'final',
    ]);
    expect(ticks[3]!.attributes('data-open')).toBe('true');
    // Open is an accent outline; focus is a --text one further out, so they never look alike.
    expect(ticks[3]!.classes()).toEqual(
      expect.arrayContaining(['outline-accent', 'outline-offset-1']),
    );
    expect(ticks[3]!.classes()).toEqual(
      expect.arrayContaining(['focus-visible:outline-text', 'focus-visible:outline-offset-2']),
    );
    expect(ticks[2]!.attributes('aria-label')).toBe('Go to event 3: terminal');
    await ticks[5]!.trigger('click');
    expect(wrapper.emitted('seek')).toEqual([[6]]);
  });

  it('is one tab stop with arrow keys, Home and End', async () => {
    wrapper = mount(TimelineScrubber, {
      props: { events: events(5), open: new Set<number>(), viewport: null },
      attachTo: document.body,
    });
    const tabbable = () =>
      wrapper!
        .findAll('[data-testid="scrubber-tick"]')
        .filter((t) => t.attributes('tabindex') === '0');
    expect(tabbable()).toHaveLength(1);
    const strip = wrapper.get('[data-testid="timeline-scrubber"]');
    await strip.trigger('keydown', { key: 'End' });
    await nextTick();
    expect(tabbable()[0]!.attributes('aria-label')).toMatch(/^Go to event 5/);
    await strip.trigger('keydown', { key: 'ArrowLeft' });
    await nextTick();
    expect(tabbable()[0]!.attributes('aria-label')).toMatch(/^Go to event 4/);
  });

  it('lets a tick stand for a few events past 160, with the look that matters most', () => {
    wrapper = mount(TimelineScrubber, {
      props: { events: events(400), open: new Set<number>(), viewport: null },
    });
    const ticks = wrapper.findAll('[data-testid="scrubber-tick"]');
    expect(ticks).toHaveLength(134);
    expect(ticks[0]!.attributes('aria-label')).toMatch(/^Go to events 1 to 3: /);
    // The last event is an error: its bucket is drawn as one.
    expect(ticks[133]!.attributes('data-look')).toBe('error');
  });
});
