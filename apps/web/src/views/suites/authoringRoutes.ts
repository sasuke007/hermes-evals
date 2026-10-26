/**
 * The routes of the suite authoring pages around the editor (Phase 5b): New suite, Import
 * tasks and Review and save. The router spreads `suiteAuthoringRoutes` into its table before
 * `/suites/:id` (so `/suites/new` is not read as a suite id) and adds the names to
 * ROUTE_NAMES.
 *
 * The draft page and the task editor are the editor's routes; they are reached by path:
 *   /suites/:suite/draft               the suite in draft mode (SA.3)
 *   /suites/:suite/draft/tasks/:key    the task editor (SA.4)
 *   ?details=1 on the draft opens Edit details.
 * `:suite` is always the folder name, as the draft API addresses it.
 */
import type { RouteLocationNormalized, RouteLocationRaw, RouteRecordRaw } from 'vue-router';

export const SUITE_AUTHORING_ROUTE_NAMES = {
  /** /suites/new (SA.2). */
  suiteNew: 'suite-new',
  /** /suites/:suite/import, tasks from CSV or JSONL into the draft (SA.9). */
  suiteImportTasks: 'suite-import-tasks',
  /** /suites/:suite/save, Review and save (SA.11). */
  suiteSave: 'suite-save',
} as const;

const folderParam = (route: RouteLocationNormalized): string => {
  const value = route.params.suite;
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
};

export const suiteAuthoringRoutes: RouteRecordRaw[] = [
  {
    path: '/suites/new',
    name: SUITE_AUTHORING_ROUTE_NAMES.suiteNew,
    component: () => import('@/views/suites/NewSuitePage.vue'),
    meta: { section: 'suites', title: 'New suite' },
  },
  {
    path: '/suites/:suite/import',
    name: SUITE_AUTHORING_ROUTE_NAMES.suiteImportTasks,
    component: () => import('@/views/suites/ImportTasksPage.vue'),
    props: (route) => ({ folder: folderParam(route) }),
    meta: { section: 'suites', title: 'Import tasks' },
  },
  {
    path: '/suites/:suite/save',
    name: SUITE_AUTHORING_ROUTE_NAMES.suiteSave,
    component: () => import('@/views/suites/SaveDraftPage.vue'),
    props: (route) => ({ folder: folderParam(route) }),
    meta: { section: 'suites', title: 'Review and save' },
  },
];

const seg = (value: string): string => encodeURIComponent(value);

/** The suite in draft mode (the editor's page). */
export const draftLocation = (folder: string, details = false): RouteLocationRaw => ({
  path: `/suites/${seg(folder)}/draft`,
  query: details ? { details: '1' } : {},
});

/** A task of the draft in the task editor (the editor's page). */
export const draftTaskLocation = (folder: string, key: string): RouteLocationRaw => ({
  path: `/suites/${seg(folder)}/draft/tasks/${seg(key)}`,
});

// The pages below are linked by path too: a name the route table does not hold yet would
// throw while rendering the link, a path only lands on Not found.

/** New suite (SA.2). */
export const newSuiteLocation: RouteLocationRaw = { path: '/suites/new' };

/** Import tasks into the folder's draft (SA.9). */
export const importTasksLocation = (folder: string): RouteLocationRaw => ({
  path: `/suites/${seg(folder)}/import`,
});

/** Review and save the folder's draft (SA.11). */
export const saveDraftLocation = (folder: string): RouteLocationRaw => ({
  path: `/suites/${seg(folder)}/save`,
});

/** A suite's folder name from its path as the API shows it: `./suites/invoices-v1` → `invoices-v1`. */
export const folderOf = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? '';
