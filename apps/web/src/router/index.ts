/**
 * The route table. Every page is lazy-loaded and every route has a name
 * (ROUTE_NAMES); link with names, not paths.
 *
 * Experiment detail is one parent page (tab row, header, and the run inspector
 * drawer) with three tabs. The drawer opens over whichever tab is showing:
 * - from the Runs tab: route `experiment-run` (/experiments/:id/runs/:runId),
 *   so the table behind keeps its filters and scroll position;
 * - from anywhere else (the comparison grid, the Overview feed): add
 *   `?run=<runId>` to the current route, so the tab does not change.
 * Esc, the scrim or browser Back closes it.
 *
 * Query parameters the pages read:
 *   /experiments/new?from=<experimentId>   duplicate an experiment
 *   /configurations/new?from=<id>          duplicate a configuration
 *   /configurations/:id?version=<n>        "view as of this experiment"
 *   any route ?scenario=<name>             fixture scenario (src/fixtures/scenarios.ts)
 */
import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteRecordRaw,
} from 'vue-router';
import type { ResourceTab } from '@/api/types/resources';

export type ShellSection = 'experiments' | 'suites' | 'configurations' | 'resources' | 'system';

declare module 'vue-router' {
  interface RouteMeta {
    /** Which top-bar section is current (AppShell reads it). */
    section?: ShellSection;
    /** Document title before " · Hermes Evals". */
    title?: string;
  }
}

export const ROUTE_NAMES = {
  experiments: 'experiments',
  experimentNew: 'experiment-new',
  /** Parent of the tabs; redirects to experiment-overview. */
  experiment: 'experiment',
  experimentOverview: 'experiment-overview',
  experimentComparison: 'experiment-comparison',
  experimentRuns: 'experiment-runs',
  experimentRun: 'experiment-run',
  suites: 'suites',
  suite: 'suite',
  task: 'task',
  configurations: 'configurations',
  configurationNew: 'configuration-new',
  configurationEdit: 'configuration-edit',
  configuration: 'configuration',
  resources: 'resources',
  resourcesTab: 'resources-tab',
  system: 'system',
  notFound: 'not-found',
} as const;

export type RouteName = (typeof ROUTE_NAMES)[keyof typeof ROUTE_NAMES];

export const RESOURCE_TABS: ResourceTab[] = ['skills', 'documents', 'mcp', 'secrets'];

const param = (route: { params: Record<string, unknown> }, name: string): string => {
  const value = route.params[name];
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
};

const query = (route: RouteLocationNormalized, name: string): string | undefined => {
  const value = route.query[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first !== '' ? first : undefined;
};

const ExperimentRunsTab = () => import('@/views/experiments/ExperimentRunsTab.vue');
const ConfigurationFormPage = () => import('@/views/configurations/ConfigurationFormPage.vue');

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: { name: ROUTE_NAMES.experiments } },
  {
    path: '/experiments',
    name: ROUTE_NAMES.experiments,
    component: () => import('@/views/experiments/ExperimentListPage.vue'),
    meta: { section: 'experiments', title: 'Experiments' },
  },
  {
    path: '/experiments/new',
    name: ROUTE_NAMES.experimentNew,
    component: () => import('@/views/experiments/NewExperimentPage.vue'),
    props: (route) => ({ duplicateOf: query(route, 'from') }),
    meta: { section: 'experiments', title: 'New experiment' },
  },
  {
    path: '/experiments/:id',
    name: ROUTE_NAMES.experiment,
    redirect: (to) => ({
      name: ROUTE_NAMES.experimentOverview,
      params: { id: param(to, 'id') },
      query: to.query,
    }),
    component: () => import('@/views/experiments/ExperimentDetailPage.vue'),
    props: (route) => ({ experimentId: param(route, 'id') }),
    meta: { section: 'experiments', title: 'Experiment' },
    children: [
      {
        path: '',
        name: ROUTE_NAMES.experimentOverview,
        component: () => import('@/views/experiments/ExperimentOverviewTab.vue'),
        props: (route) => ({ experimentId: param(route, 'id') }),
        meta: { section: 'experiments', title: 'Overview' },
      },
      {
        path: 'comparison',
        name: ROUTE_NAMES.experimentComparison,
        component: () => import('@/views/experiments/ExperimentComparisonTab.vue'),
        props: (route) => ({ experimentId: param(route, 'id') }),
        meta: { section: 'experiments', title: 'Comparison' },
      },
      {
        path: 'runs',
        name: ROUTE_NAMES.experimentRuns,
        component: ExperimentRunsTab,
        props: (route) => ({ experimentId: param(route, 'id') }),
        meta: { section: 'experiments', title: 'Runs' },
      },
      {
        path: 'runs/:runId',
        name: ROUTE_NAMES.experimentRun,
        component: ExperimentRunsTab,
        props: (route) => ({ experimentId: param(route, 'id') }),
        meta: { section: 'experiments', title: 'Run' },
      },
    ],
  },
  {
    path: '/suites',
    name: ROUTE_NAMES.suites,
    component: () => import('@/views/suites/SuiteListPage.vue'),
    meta: { section: 'suites', title: 'Suites' },
  },
  {
    path: '/suites/:id',
    name: ROUTE_NAMES.suite,
    component: () => import('@/views/suites/SuiteDetailPage.vue'),
    props: (route) => ({ suiteId: param(route, 'id') }),
    meta: { section: 'suites', title: 'Suite' },
  },
  {
    path: '/suites/:id/tasks/:key',
    name: ROUTE_NAMES.task,
    component: () => import('@/views/suites/TaskDetailPage.vue'),
    props: (route) => ({ suiteId: param(route, 'id'), taskKey: param(route, 'key') }),
    meta: { section: 'suites', title: 'Task' },
  },
  {
    path: '/configurations',
    name: ROUTE_NAMES.configurations,
    component: () => import('@/views/configurations/ConfigurationListPage.vue'),
    meta: { section: 'configurations', title: 'Configurations' },
  },
  {
    path: '/configurations/new',
    name: ROUTE_NAMES.configurationNew,
    component: ConfigurationFormPage,
    props: (route) => {
      const from = query(route, 'from');
      return from
        ? { mode: 'duplicate' as const, configurationId: from }
        : { mode: 'new' as const, configurationId: undefined };
    },
    meta: { section: 'configurations', title: 'New configuration' },
  },
  {
    path: '/configurations/:id/edit',
    name: ROUTE_NAMES.configurationEdit,
    component: ConfigurationFormPage,
    props: (route) => ({ mode: 'edit' as const, configurationId: param(route, 'id') }),
    meta: { section: 'configurations', title: 'Edit configuration' },
  },
  {
    path: '/configurations/:id',
    name: ROUTE_NAMES.configuration,
    component: () => import('@/views/configurations/ConfigurationDetailPage.vue'),
    props: (route) => {
      const version = Number(query(route, 'version'));
      return {
        configurationId: param(route, 'id'),
        version: Number.isInteger(version) && version > 0 ? version : undefined,
      };
    },
    meta: { section: 'configurations', title: 'Configuration' },
  },
  {
    path: '/resources',
    name: ROUTE_NAMES.resources,
    redirect: { name: ROUTE_NAMES.resourcesTab, params: { tab: 'skills' } },
    meta: { section: 'resources', title: 'Resources' },
  },
  {
    path: '/resources/:tab(skills|documents|mcp|secrets)',
    name: ROUTE_NAMES.resourcesTab,
    component: () => import('@/views/resources/ResourceLibraryPage.vue'),
    props: (route) => ({ tab: param(route, 'tab') as ResourceTab }),
    meta: { section: 'resources', title: 'Resources' },
  },
  {
    path: '/system',
    name: ROUTE_NAMES.system,
    component: () => import('@/views/system/SystemPage.vue'),
    meta: { section: 'system', title: 'System' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: ROUTE_NAMES.notFound,
    component: () => import('@/views/NotFoundPage.vue'),
    meta: { title: 'Page not found' },
  },
];

/** The run the inspector drawer shows on an experiment route: `:runId`, else `?run=`. */
export function inspectedRunId(route: RouteLocationNormalized): string | null {
  return param(route, 'runId') || query(route, 'run') || null;
}

function isExperimentRoute(route: RouteLocationNormalized): boolean {
  return route.matched.some((r) => r.name === ROUTE_NAMES.experiment);
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    if (to.hash) return { el: to.hash };
    // Opening, closing or stepping the run inspector keeps the page behind where it was.
    if (
      isExperimentRoute(to) &&
      isExperimentRoute(from) &&
      param(to, 'id') === param(from, 'id') &&
      (inspectedRunId(to) !== null || inspectedRunId(from) !== null)
    ) {
      return false;
    }
    // Filters and sort live in the query: changing them does not scroll.
    if (to.path === from.path) return false;
    return { top: 0 };
  },
});

router.afterEach((to) => {
  if (typeof document === 'undefined') return;
  const title = [...to.matched].reverse().find((r) => r.meta.title)?.meta.title;
  document.title = title ? `${title} · Hermes Evals` : 'Hermes Evals';
});

export default router;
