/**
 * Arrow-key movement over a grid of cells (plan 12.4: the comparison's TaskGrid, where each
 * row is a task and its cells are the repetitions of both configurations). One cell is in the
 * tab order at a time (roving tabindex); the arrows move it, Home and End go to the row's
 * ends, Ctrl+Home and Ctrl+End to the grid's, Page Up and Page Down by `pageSize` rows, and
 * Enter or Space activates it (open the run). Rows may have different numbers of cells: moving
 * up or down keeps the column where it can and clamps it where the row is shorter.
 *
 *   const grid = useKeyboardGrid({ container: gridEl, rows: () => rows.length,
 *     cols: (r) => rows[r].cells.length, onActivate: (r, c) => open(rows[r].cells[c]) });
 *   <div ref="gridEl" role="grid" @keydown="grid.onKeydown">
 *     <button v-bind="grid.cellAttrs(r, c)" …>
 */
import { nextTick, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue';

export interface GridPosition {
  row: number;
  col: number;
}

export interface KeyboardGridOptions {
  /** The element around the cells; cells are found by their data-grid-row/col. */
  container: Ref<HTMLElement | null>;
  rows: MaybeRefOrGetter<number>;
  /** How many cells row `row` has. */
  cols: (row: number) => number;
  onActivate?: (row: number, col: number) => void;
  /** Called after the active cell moved (by key or focus). */
  onMove?: (position: GridPosition) => void;
  /** Rows per Page Up / Page Down. Default 5. */
  pageSize?: number;
}

export function useKeyboardGrid(options: KeyboardGridOptions) {
  const active = ref<GridPosition>({ row: 0, col: 0 });
  const pageSize = options.pageSize ?? 5;

  const rowCount = (): number => Math.max(0, toValue(options.rows));
  const colCount = (row: number): number => Math.max(0, options.cols(row));

  /** The nearest row from `row` in direction `step` that has cells, or null. */
  function rowWithCells(row: number, step: 1 | -1): number | null {
    for (let r = row; r >= 0 && r < rowCount(); r += step) if (colCount(r) > 0) return r;
    return null;
  }

  function clamp(position: GridPosition): GridPosition {
    const rows = rowCount();
    if (rows === 0) return { row: 0, col: 0 };
    let row = Math.min(Math.max(0, position.row), rows - 1);
    row = rowWithCells(row, 1) ?? rowWithCells(row, -1) ?? row;
    const cols = colCount(row);
    return { row, col: cols === 0 ? 0 : Math.min(Math.max(0, position.col), cols - 1) };
  }

  function cellAt(position: GridPosition): HTMLElement | null {
    return (
      options.container.value?.querySelector<HTMLElement>(
        `[data-grid-row="${position.row}"][data-grid-col="${position.col}"]`,
      ) ?? null
    );
  }

  /** Make a cell the active one and move focus to it. */
  async function focus(row: number, col: number): Promise<void> {
    active.value = clamp({ row, col });
    options.onMove?.(active.value);
    await nextTick();
    cellAt(active.value)?.focus();
  }

  function target(event: KeyboardEvent, from: GridPosition): GridPosition | null {
    const last = rowCount() - 1;
    switch (event.key) {
      case 'ArrowRight':
        return { row: from.row, col: from.col + 1 };
      case 'ArrowLeft':
        return { row: from.row, col: from.col - 1 };
      case 'ArrowDown': {
        const row = rowWithCells(from.row + 1, 1);
        return row === null ? from : { row, col: from.col };
      }
      case 'ArrowUp': {
        const row = rowWithCells(from.row - 1, -1);
        return row === null ? from : { row, col: from.col };
      }
      case 'Home':
        return event.ctrlKey || event.metaKey ? { row: 0, col: 0 } : { row: from.row, col: 0 };
      case 'End':
        return event.ctrlKey || event.metaKey
          ? { row: last, col: colCount(last) - 1 }
          : { row: from.row, col: colCount(from.row) - 1 };
      case 'PageDown':
        return { row: Math.min(last, from.row + pageSize), col: from.col };
      case 'PageUp':
        return { row: Math.max(0, from.row - pageSize), col: from.col };
      default:
        return null;
    }
  }

  /** Bind to the grid's keydown. Keys from elements that are not cells are left alone. */
  function onKeydown(event: KeyboardEvent): void {
    const cell = (event.target as HTMLElement | null)?.closest?.('[data-grid-row]');
    if (!cell || !(cell instanceof HTMLElement)) return;
    const from = clamp({
      row: Number(cell.dataset.gridRow),
      col: Number(cell.dataset.gridCol),
    });
    if (event.key === 'Enter' || event.key === ' ') {
      if (!options.onActivate) return;
      event.preventDefault();
      options.onActivate(from.row, from.col);
      return;
    }
    const to = target(event, from);
    if (!to) return;
    event.preventDefault();
    void focus(to.row, to.col);
  }

  const isActive = (row: number, col: number): boolean =>
    active.value.row === row && active.value.col === col;

  /** Attributes for cell (row, col): its position, the roving tabindex, focus tracking. */
  function cellAttrs(row: number, col: number) {
    return {
      'data-grid-row': row,
      'data-grid-col': col,
      tabindex: isActive(row, col) ? 0 : -1,
      onFocus: () => {
        if (!isActive(row, col)) {
          active.value = { row, col };
          options.onMove?.(active.value);
        }
      },
    };
  }

  // Rows came or went (a filter): keep the active cell inside the grid.
  watch(
    () => `${rowCount()}:${colCount(active.value.row)}`,
    () => {
      const next = clamp(active.value);
      if (next.row !== active.value.row || next.col !== active.value.col) active.value = next;
    },
  );

  return { active, onKeydown, focus, isActive, cellAttrs };
}
