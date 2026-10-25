import type { RouteLocationRaw } from 'vue-router';
import type { Tone } from '@/lib/statusTones';

/** LiveIndicator states. */
export type LiveState = 'live' | 'reconnecting' | 'paused' | 'offline' | 'finished';

/** SkeletonRows column: a width (px number or CSS string) or a width per row. */
export type SkeletonWidth = number | string;
export interface SkeletonBar {
  /** One width, or one per row (cycled): [220, 180, 240, …]. */
  width: SkeletonWidth | SkeletonWidth[];
  /** Bar height in px. Default 10; 16 for chip-shaped bars. */
  height?: number;
  align?: 'left' | 'right';
}
export type SkeletonColumn = SkeletonWidth | SkeletonBar;

/** SegmentedControl option. */
export interface SegmentOption<V extends string | number = string> {
  value: V;
  label: string;
  /** Shown after the label: "Improved 8". */
  count?: number | null;
}

/** KeyValueList item. */
export interface KeyValueItem {
  key: string;
  label: string;
  /** null or '' shows the en dash in --text-3; a #value-<key> slot replaces it. */
  value?: string | number | null;
  /** Ids, versions, paths: IBM Plex Mono. */
  mono?: boolean;
  /** Marks the row on --accent-soft (ConfigDetail: the field this version changed). */
  highlight?: boolean;
}

/** Breadcrumb item. */
export interface BreadcrumbItem {
  label: string;
  /** Omit on the last item, the current page. */
  to?: RouteLocationRaw | null;
}

/** ProgressBar segment: a share of the bar in a tone. */
export interface ProgressSegment {
  value: number;
  /** A status tone, or muted (--text-3: spend). */
  tone: Tone | 'muted';
  /** hatch: queued work still to come (OverviewRunning per configuration). */
  pattern?: 'solid' | 'hatch';
  /** Live work pulses (running, scoring). */
  pulse?: boolean;
  /** Names the segment for the bar's title. */
  label?: string;
}

/** Select option. */
export interface SelectOption<V extends string | number = string> {
  value: V;
  label: string;
  disabled?: boolean;
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
  /** Marks the tab current whatever the route says (a sibling route that belongs to it). */
  active?: boolean;
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
  /**
   * Skeleton bar while loading: width(s), or { width, height } for chip-shaped bars (16px).
   * Defaults to 60% of the column.
   */
  skeleton?: SkeletonWidth | SkeletonWidth[] | Omit<SkeletonBar, 'align'>;
}

export type SortDir = 'asc' | 'desc';
export interface DataTableSort {
  key: string;
  dir: SortDir;
}
export type RowKey = string | number;
export type Density = 'compact' | 'default';
