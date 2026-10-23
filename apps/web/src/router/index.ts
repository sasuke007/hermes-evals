import { createRouter, createWebHistory } from 'vue-router';
import PlaceholderView from '@/views/PlaceholderView.vue';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/experiments' },
    {
      path: '/experiments',
      name: 'experiments',
      component: PlaceholderView,
      props: {
        title: 'Experiments',
        body: 'An experiment runs every task in a suite under two or more configurations, several times each, and tells you whether the candidate beat the baseline.',
      },
    },
    {
      path: '/suites',
      name: 'suites',
      component: PlaceholderView,
      props: {
        title: 'Suites',
        body: 'Suites are read from ./suites on disk and are read-only here.',
      },
    },
    {
      path: '/configurations',
      name: 'configurations',
      component: PlaceholderView,
      props: {
        title: 'Configurations',
        body: 'A configuration records how the agent is set up: model, provider, toolsets, memory, skills, documents and MCP servers.',
      },
    },
    {
      path: '/resources',
      name: 'resources',
      component: PlaceholderView,
      props: {
        title: 'Resources',
        body: 'Skills, documents, MCP servers and secrets that a configuration can include.',
      },
    },
    { path: '/system', name: 'system', component: () => import('@/views/SystemView.vue') },
  ],
});

export default router;
