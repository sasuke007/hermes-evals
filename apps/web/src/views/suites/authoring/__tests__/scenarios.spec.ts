/**
 * The draft scenarios (src/api/drafts-scenarios.ts): each listed once in the registry, routes
 * the editor's routes resolve, and every draft and task of each scenario within its contract.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { DraftTaskDetailSchema, SuiteDraftViewSchema } from '@hermes-evals/shared';
import { DRAFT_SCENARIOS } from '@/api/drafts-scenarios';
import { draftWorld, resetDraftFixtures } from '@/api/drafts-fixtures';
import { draftView, taskDetailView } from '@/api/drafts-fixture-views';
import { setScenario } from '@/api/__tests__/scenario';
import { SCENARIOS } from '@/fixtures/scenarios';
import { ROUTE_NAMES, routes } from '@/router';

describe('draft scenarios', () => {
  it('are each listed once in the registry', () => {
    const listed = SCENARIOS.map((s) => s.name);
    const counts = DRAFT_SCENARIOS.map(({ name }) => [
      name,
      listed.filter((n) => n === name).length,
    ]);
    expect(counts).toEqual(DRAFT_SCENARIOS.map(({ name }) => [name, 1]));
  });

  it('point at routes the editor resolves', () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    const broken = DRAFT_SCENARIOS.flatMap((s) => [s.route, ...(s.alsoAt ?? [])]).filter(
      (path) => router.resolve(path).name === ROUTE_NAMES.notFound,
    );
    expect(broken).toEqual([]);
  });

  it.each(DRAFT_SCENARIOS.map((s) => s.name))('serves %s within the contracts', (name) => {
    setScenario(name);
    resetDraftFixtures();
    for (const draft of draftWorld().values()) {
      expect(() => SuiteDraftViewSchema.parse(draftView(draft))).not.toThrow();
      for (const task of draft.tasks)
        expect(() => DraftTaskDetailSchema.parse(taskDetailView(draft, task))).not.toThrow();
    }
  });
});
