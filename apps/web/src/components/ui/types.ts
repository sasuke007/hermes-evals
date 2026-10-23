import type { RouteLocationRaw } from 'vue-router';

/** LiveIndicator states. */
export type LiveState = 'live' | 'reconnecting' | 'paused' | 'offline' | 'finished';

/** SkeletonRows column: a width (px number or CSS string) or a width per row. */
export type SkeletonWidth = number | string;
export type SkeletonColumn =
  | SkeletonWidth
  | {
      /** One width, or one per row (cycled): [220, 180, 240, …]. */
      width: SkeletonWidth | SkeletonWidth[];
      /** Bar height in px. Default 10; 16 for chip-shaped bars. */
      height?: number;
      align?: 'left' | 'right';
    };

/** SegmentedControl option. */
export interface SegmentOption<V extends string | number = string> {
  value: V;
  label: string;
  /** Shown after the label: "Improved 8". */
  count?: number | null;
}

/** TabNav item. */
export interface TabItem {
  key?: string;
  label: string;
  to: RouteLocationRaw;
  /** Shown after the label in mono, --text-3: "Runs 120". */
  count?: number | string | null;
  /** Only the exact route marks the tab current (an Overview tab whose path prefixes others). */
  exact?: boolean;
}

/** DataTable column. */
export interface DataTableColumn<Row = Record<string, unknown>> {
  key: string;
  label: string;
  align?: 'left' | 'right';
  sortable?: boolean;
  /** CSS width of the column: a px number or a string such as '30%'. */
  width?: number | string;
  /** Cell text in IBM Plex Mono 12px (ids, keys, paths). */
  mono?: boolean;
  /** Sticks to the left edge when the table scrolls sideways. */
  sticky?: boolean;
  /** Value used to sort; defaults to row[key]. */
  sortValue?: (row: Row) => unknown;
  /** Text used for the cell when no #cell-<key> slot is given; defaults to row[key]. */
  format?: (row: Row) => string;
  /** Skeleton bar width(s) while loading; defaults to 60% of the column. */
  skeleton?: SkeletonWidth | SkeletonWidth[];
}

export type SortDir = 'asc' | 'desc';
export interface DataTableSort {
  key: string;
  dir: SortDir;
}
export type RowKey = string | number;
export type Density = 'compact' | 'default';
