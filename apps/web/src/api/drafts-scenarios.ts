/**
 * The designed states of the suite draft and the task editor (SA.3 to SA.8, SA.12, SA.13) as
 * fixture scenarios, for src/fixtures/scenarios.ts to list (the integrator spreads
 * DRAFT_SCENARIOS into SCENARIOS and DRAFT_SCENARIO_NAMES into the registry test's names).
 * `no-worker`, `loading`, `error` and `empty` are the global scenarios; the draft data layer
 * reads them too.
 */
import type { ScenarioEntry } from '@/fixtures/scenarios';

const draft = '/suites/invoices-v1/draft';
const task = (key: string, tab = '') => `${draft}/tasks/${key}${tab}`;

export const DRAFT_SCENARIOS: ScenarioEntry[] = [
  {
    name: 'draft-none',
    domain: 'suites',
    description:
      'invoices-v1 has no draft: the draft page offers Start a draft, and the suite list shows no draft chip.',
    route: draft,
  },
  {
    name: 'draft-removed',
    domain: 'suites',
    description:
      'The invoices-v1 draft also removes currency_mix: 4 changes collapse to "+2 more", the row is struck through with Undo.',
    route: draft,
  },
  {
    name: 'draft-restored',
    domain: 'suites',
    description:
      'total_due restored from v1 into a draft based on v2: the row and the bar read "restored from v1", "v2 → v1 on save".',
    route: draft,
  },
  {
    name: 'draft-label-empty',
    domain: 'suites',
    description:
      'The draft\'s version label is empty: "Add a version label." blocks Review and save (a suite-level problem).',
    route: `${draft}?details=1`,
  },
  {
    name: 'draft-conflict',
    domain: 'suites',
    description:
      'A reload created v2 (late_fees) after the draft began on v1: the bar turns amber and offers Combine onto v2; no task overlaps.',
    route: draft,
  },
  {
    name: 'draft-conflict-overlap',
    domain: 'suites',
    description:
      'v2 on disk changed total_due, which the draft changed too: Combine waits for Keep my version or Keep the version on disk.',
    route: draft,
  },
  {
    name: 'draft-saving',
    domain: 'suites',
    description:
      'A save of the draft is running (self-checks 1 of 2): writes to the draft are refused until it ends.',
    route: draft,
  },
  {
    name: 'draft-new-suite',
    domain: 'suites',
    description:
      'Flow E step 3: vendor-statements-v1, a new suite with no tasks; Review and save as v1 waits for "Add at least one task to save v1."',
    route: '/suites/vendor-statements-v1/draft',
  },
  {
    name: 'task-flowe',
    domain: 'suites',
    description:
      'Flow E step 4: unmatched_lines with its prompt but no files, reference or check; the panel lists what is missing.',
    route: '/suites/vendor-statements-v1/draft/tasks/unmatched_lines',
  },
  {
    name: 'task-problems',
    domain: 'suites',
    description:
      'SA.5: overdue_count reads answer path overdue, has no answer paragraph, mentions a missing ledger.csv and a file under docs/; total_due leaks its reference in notes.txt.',
    route: task('overdue_count'),
    alsoAt: [task('total_due')],
  },
  {
    name: 'task-yaml-error',
    domain: 'suites',
    description:
      'SA.6: overdue_count\'s task.yaml has "prmary" on line 10: the form locks, and the task.yaml tab offers Change to primary.',
    route: task('overdue_count', '?tab=yaml'),
    alsoAt: [task('overdue_count')],
  },
  {
    name: 'self-check-failed',
    domain: 'suites',
    description:
      "Run self-check on summary_file fails: the expected workspace's summary.csv has 8 data rows; the check needs 9.",
    route: task('summary_file'),
  },
  {
    name: 'self-check-negative',
    domain: 'suites',
    description:
      'Run self-check on summary_file: the file check passes on the untouched workspace, so the negative control fails.',
    route: task('summary_file'),
  },
  {
    name: 'self-check-error',
    domain: 'suites',
    description:
      "Run self-check on summary_file: the verifier script exits with status 1 (KeyError: 'totals'); the panel shows its transcript.",
    route: task('summary_file'),
  },
  {
    name: 'task-large-text',
    domain: 'suites',
    description:
      'Files tab of overdue_count: rubrics/method.md came in a zip at 1.4 MB, over the 1 MiB an editor holds, so it is kept as an other file, saved as is and shown read-only (Phase 5b question 18).',
    route: task('overdue_count', '?tab=files'),
  },
];

export const DRAFT_SCENARIO_NAMES = DRAFT_SCENARIOS.map((s) => s.name);
