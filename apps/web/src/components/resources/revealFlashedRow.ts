import { nextTick, watch, type WatchSource } from 'vue';

/**
 * A row just added or saved flashes (the store's flashId) where the API's order puts it, by
 * name, so in a long list it can land below the fold and the flash goes unseen. Once the row
 * is drawn, and the dialog that added it has given focus back, this brings it into view.
 */
export function useRevealFlashedRow(flashId: WatchSource<string | null>): void {
  watch(flashId, async (id) => {
    if (!id) return;
    await nextTick();
    document.querySelector('tr.animate-flash')?.scrollIntoView?.({ block: 'nearest' });
  });
}
