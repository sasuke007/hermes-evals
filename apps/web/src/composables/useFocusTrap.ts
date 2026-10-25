/**
 * Focus handling for an overlay (Dialog, Drawer): when it opens, remember what had focus and
 * move focus inside (the [data-primary] element, else the first focusable, else the container);
 * while open, Tab and Shift+Tab cycle inside it and Esc calls onEscape; when it closes, focus
 * returns to where it was, or, when that element is gone (a live list moved on, the overlay
 * was opened by URL), to what returnFocusFallback names. Bind `onKeydown` to the container's
 * keydown.
 */
import { nextTick, onBeforeUnmount, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue';

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusTrapOptions {
  /** True while the overlay is shown. */
  active: MaybeRefOrGetter<boolean>;
  /** Esc pressed inside. Omit to leave Esc alone. */
  onEscape?: () => void;
  /** Where focus starts: a selector inside the container. Default '[data-primary]'. */
  initialFocus?: string;
  /** false keeps focus where the overlay left it on close. Default true. */
  returnFocus?: boolean;
  /** Where focus goes on close when the element it came from is gone (or there was none). */
  returnFocusFallback?: (() => HTMLElement | null) | null;
}

export function useFocusTrap(container: Ref<HTMLElement | null>, options: FocusTrapOptions) {
  let restoreTo: HTMLElement | null = null;

  function focusables(): HTMLElement[] {
    const el = container.value;
    return el ? Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
  }

  /** Move focus to the start element (also after the content changed under the user). */
  async function focusStart(): Promise<void> {
    await nextTick();
    const el = container.value;
    if (!el) return;
    const target =
      el.querySelector<HTMLElement>(options.initialFocus ?? '[data-primary]') ??
      focusables()[0] ??
      el;
    target.focus();
  }

  /** Give focus back: to where it was, else to the fallback. */
  function restore(target: HTMLElement | null): void {
    if (options.returnFocus === false) return;
    const to = target?.isConnected ? target : (options.returnFocusFallback?.() ?? null);
    to?.focus();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && options.onEscape) {
      event.preventDefault();
      event.stopPropagation();
      options.onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !container.value?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  watch(
    () => toValue(options.active),
    (open, wasOpen) => {
      if (open && !wasOpen) {
        const active = typeof document === 'undefined' ? null : document.activeElement;
        restoreTo = active instanceof HTMLElement && active !== document.body ? active : null;
        void focusStart();
      } else if (!open && wasOpen) {
        const target = restoreTo;
        restoreTo = null;
        restore(target);
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    // Unmounted while open (a route change closed it): still give focus back.
    const target = restoreTo;
    restoreTo = null;
    if (toValue(options.active)) restore(target);
  });

  return { onKeydown, focusStart, focusables };
}
