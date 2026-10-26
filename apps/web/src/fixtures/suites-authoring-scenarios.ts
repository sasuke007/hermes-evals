/**
 * The fixture scenarios of the suite pages around the editor (Phase 5b), for the registry in
 * ./scenarios.ts, which lists them with the rest. The editor's own (a draft's states, the
 * task editor's, draft-conflict and draft-conflict-overlap) are listed with the editor.
 * Without a scenario the suite list, New suite, Import tasks and Review and save run on the
 * default fixtures: an open draft of invoices-v1 with 3 changes.
 */
import type { ScenarioEntry } from './scenarios';
import { SUITE_V1_ID } from './suites';

export const SUITE_AUTHORING_SCENARIOS: ScenarioEntry[] = [
  {
    name: 'missing-folders',
    domain: 'suites',
    description:
      'Three zz-smoke folders are gone from disk: the suite list hides them behind "Show 3 missing from disk", where each reads "Missing from disk".',
    route: '/suites',
  },
  {
    name: 'draft-invalid-task',
    domain: 'suites',
    description:
      'Review and save with overdue_count failing its self-check: "1 of 2 changed tasks ready", and Save asks "Save with 1 invalid task?" first.',
    route: '/suites/invoices-v1/save',
  },
  {
    name: 'draft-no-changes',
    domain: 'suites',
    description:
      'The draft holds the base version\'s files: Review and save lists no change, and saving says "Nothing changed. invoices-v1 stays at v1."',
    route: '/suites/invoices-v1/save',
  },
  {
    name: 'save-failed',
    domain: 'suites',
    description:
      'The staging folder fails the loader: "Not saved. overdue_count/task.yaml line 9: unknown key prmary. Nothing on disk changed. Your draft is kept.", with the Loading step marked.',
    route: '/suites/invoices-v1/save',
  },
];

/** Where the default fixtures show each authoring page (no scenario needed). */
export const SUITE_AUTHORING_PAGES = {
  list: '/suites',
  newSuite: '/suites/new',
  importTasks: '/suites/invoices-v1/import',
  save: '/suites/invoices-v1/save',
  restore: `/suites/${SUITE_V1_ID}/tasks/total_due?scenario=newer-version`,
} as const;
