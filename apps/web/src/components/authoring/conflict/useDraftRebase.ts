/**
 * Combine onto the newer version (SA.12): the amber SuiteDraftBar's Combine sends the
 * choices made in the resolver. It answers the draft based on the newer version, or a new
 * conflict when the folder moved again meanwhile (409), which the bar then shows instead.
 */
import { ref } from 'vue';
import { errorMessage } from '@/api/client';
import type { RebaseOutcome } from '@/api/suites-authoring';
import type { DraftConflict } from '@/api/types/authoring';
import { useSuiteAuthoringStore } from '@/stores/suites-authoring';
import { combineBlockedReason, rebaseRequest, type ConflictChoices } from './conflict';

export function useDraftRebase(folder: () => string) {
  const store = useSuiteAuthoringStore();
  const combining = ref(false);
  /** A failure other than a new conflict, verbatim. */
  const error = ref<string | null>(null);

  async function combine(
    conflict: DraftConflict,
    choices: ConflictChoices,
  ): Promise<RebaseOutcome | null> {
    if (combining.value || combineBlockedReason(conflict, choices)) return null;
    combining.value = true;
    error.value = null;
    try {
      return await store.rebase(folder(), rebaseRequest(conflict, choices));
    } catch (err) {
      error.value = errorMessage(err);
      return null;
    } finally {
      combining.value = false;
    }
  }

  return { combining, error, combine };
}
