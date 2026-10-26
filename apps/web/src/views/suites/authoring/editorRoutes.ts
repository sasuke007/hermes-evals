/**
 * The routes of the suite draft and the task editor (Phase 5b, SA.3 to SA.8). The router
 * spreads `suiteEditorRoutes` into its table before `/suites/:id`, and the names join
 * ROUTE_NAMES. `:suite` is the folder name, as the draft API addresses suites.
 *
 *   /suites/:suite/draft                  the suite in draft mode (SA.3); ?details=1 opens Edit details
 *   /suites/:suite/draft/tasks/:key       the task editor (SA.4); ?tab=files|yaml
 */
import type { RouteLocationNormalized, RouteLocationRaw, RouteRecordRaw } from 'vue-router';

export const SUITE_EDITOR_ROUTE_NAMES = {
  suiteDraft: 'suite-draft',
  draftTask: 'draft-task',
} as const;

export type EditorTab = 'form' | 'files' | 'yaml';

const param = (route: RouteLocationNormalized, name: string): string => {
  const value = route.params[name];
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
};

const tabOf = (route: RouteLocationNormalized): EditorTab => {
  const tab = route.query.tab;
  return tab === 'files' || tab === 'yaml' ? tab : 'form';
};

export const suiteEditorRoutes: RouteRecordRaw[] = [
  {
    path: '/suites/:suite/draft',
    name: SUITE_EDITOR_ROUTE_NAMES.suiteDraft,
    component: () => import('./SuiteDraftPage.vue'),
    props: (route) => ({ folder: param(route, 'suite'), details: route.query.details === '1' }),
    meta: { section: 'suites', title: 'Suite draft' },
  },
  {
    path: '/suites/:suite/draft/tasks/:key',
    name: SUITE_EDITOR_ROUTE_NAMES.draftTask,
    component: () => import('./TaskEditorPage.vue'),
    props: (route) => ({
      folder: param(route, 'suite'),
      taskKey: param(route, 'key'),
      tab: tabOf(route),
    }),
    meta: { section: 'suites', title: 'Edit task' },
  },
];

/** The suite in draft mode. */
export const suiteDraftRoute = (folder: string, details = false): RouteLocationRaw => ({
  name: SUITE_EDITOR_ROUTE_NAMES.suiteDraft,
  params: { suite: folder },
  query: details ? { details: '1' } : {},
});

/** A task of the draft in the editor, on a tab. */
export const draftTaskRoute = (
  folder: string,
  key: string,
  tab: EditorTab = 'form',
): RouteLocationRaw => ({
  name: SUITE_EDITOR_ROUTE_NAMES.draftTask,
  params: { suite: folder, key },
  query: tab === 'form' ? {} : { tab },
});
