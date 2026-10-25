import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { useKeyboardGrid } from '@/composables/useKeyboardGrid';

/** Rows of cells: the comparison grid's tasks × repetitions; row 2 is shorter. */
const ROWS = [10, 10, 4, 0, 10];

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

function setup(rows = ROWS) {
  const onActivate = vi.fn<(row: number, col: number) => void>();
  const Grid = defineComponent({
    setup() {
      const el = ref<HTMLElement | null>(null);
      const grid = useKeyboardGrid({
        container: el,
        rows: () => rows.length,
        cols: (r) => rows[r] ?? 0,
        onActivate,
      });
      return () =>
        h(
          'div',
          { ref: el, role: 'grid', onKeydown: grid.onKeydown },
          rows.map((cols, r) =>
            h(
              'div',
              { role: 'row' },
              Array.from({ length: cols }, (_, c) =>
                h('button', { ...grid.cellAttrs(r, c), type: 'button' }, `${r}:${c}`),
              ),
            ),
          ),
        );
    },
  });
  wrapper = mount(Grid, { attachTo: document.body });
  return { w: wrapper, onActivate };
}

const focused = () => (document.activeElement as HTMLElement | null)?.textContent;
const cell = (w: VueWrapper, r: number, c: number) =>
  w.get(`[data-grid-row="${r}"][data-grid-col="${c}"]`);

async function press(w: VueWrapper, key: string, extra: KeyboardEventInit = {}) {
  const active = document.activeElement as HTMLElement;
  active.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }));
  await new Promise((r) => setTimeout(r, 0));
  void w;
}

describe('useKeyboardGrid', () => {
  it('keeps one cell in the tab order', () => {
    const { w } = setup();
    const tabbable = w.findAll('[tabindex="0"]');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]!.text()).toBe('0:0');
    expect(w.findAll('[tabindex="-1"]').length).toBe(33);
  });

  it('moves with the arrows and stops at the edges', async () => {
    const { w } = setup();
    (cell(w, 0, 0).element as HTMLElement).focus();
    await press(w, 'ArrowRight');
    expect(focused()).toBe('0:1');
    await press(w, 'ArrowDown');
    expect(focused()).toBe('1:1');
    await press(w, 'ArrowLeft');
    await press(w, 'ArrowLeft');
    expect(focused()).toBe('1:0');
    await press(w, 'ArrowUp');
    await press(w, 'ArrowUp');
    expect(focused()).toBe('0:0');
    expect(cell(w, 0, 0).attributes('tabindex')).toBe('0');
    expect(cell(w, 1, 0).attributes('tabindex')).toBe('-1');
  });

  it('clamps the column on a shorter row and skips empty rows', async () => {
    const { w } = setup();
    (cell(w, 1, 8).element as HTMLElement).focus();
    await press(w, 'ArrowDown');
    expect(focused()).toBe('2:3');
    await press(w, 'ArrowDown');
    expect(focused()).toBe('4:3');
  });

  it('goes to the row ends with Home and End, the grid ends with Ctrl', async () => {
    const { w } = setup();
    (cell(w, 1, 4).element as HTMLElement).focus();
    await press(w, 'End');
    expect(focused()).toBe('1:9');
    await press(w, 'Home');
    expect(focused()).toBe('1:0');
    await press(w, 'End', { ctrlKey: true });
    expect(focused()).toBe('4:9');
    await press(w, 'Home', { ctrlKey: true });
    expect(focused()).toBe('0:0');
  });

  it('activates the cell with Enter and Space', async () => {
    const { w, onActivate } = setup();
    (cell(w, 2, 3).element as HTMLElement).focus();
    await press(w, 'Enter');
    await press(w, ' ');
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onActivate).toHaveBeenCalledWith(2, 3);
  });

  it('follows focus that arrives by click or Tab', async () => {
    const { w } = setup();
    await cell(w, 4, 2).trigger('focus');
    expect(cell(w, 4, 2).attributes('tabindex')).toBe('0');
    expect(cell(w, 0, 0).attributes('tabindex')).toBe('-1');
  });
});
