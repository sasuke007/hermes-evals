/**
 * Every fixture scenario: its name, what it shows and where to look.
 *
 * Open any route with ?scenario=<name> (or several, comma-separated, e.g.
 * ?scenario=paused-provider,nous-not-connected). The choice is remembered for
 * the browser tab; ?scenario=clear forgets it. src/api/source.ts reads it.
 *
 * `baseData` scenarios show a state the default fixtures already contain;
 * the entry documents the route where it is drawn.
 */
import { DRAFT_SCENARIOS } from '@/api/drafts-scenarios';
import { EXPERIMENT_IDS, SAMPLE_RUN_ID } from './experiments';
import { runIdOf } from './inspector';
import { PHASE8_SCENARIOS } from './phase8-scenarios';
import { CONFIG_IDS } from './resources';
import { SUITE_V1_ID, SUITE_V2_ID } from './suites';
import { SUITE_AUTHORING_SCENARIOS } from './suites-authoring-scenarios';

export type ScenarioDomain =
  'global' | 'experiments' | 'inspector' | 'suites' | 'library' | 'system';

export interface ScenarioEntry {
  name: string;
  domain: ScenarioDomain;
  description: string;
  /** Where to look first. */
  route: string;
  /** Other routes the scenario changes. */
  alsoAt?: string[];
  /** The default fixtures already show this state; the name documents the route. */
  baseData?: boolean;
}

const base = () => false;
const exp = (key: keyof typeof EXPERIMENT_IDS, tail = '') =>
  `/experiments/${EXPERIMENT_IDS[key]}${tail}`;
const run = (key: keyof typeof EXPERIMENT_IDS, task: string, config: string, rep: number) =>
  exp(key, `/runs/${runIdOf(base, EXPERIMENT_IDS[key], task, config, rep) ?? ''}`);

export const SCENARIOS: ScenarioEntry[] = [
  // Global ------------------------------------------------------------------
  {
    name: 'loading',
    domain: 'global',
    description: 'Every fixture-backed request stays pending: skeleton rows at real column widths.',
    route: '/experiments',
    alsoAt: ['/suites', '/configurations', '/resources/skills', '/system'],
  },
  {
    name: 'error',
    domain: 'global',
    description:
      'Every fixture-backed request fails like a stopped api service: "GET /api/experiments → 502 · upstream api:8080 connection refused".',
    route: '/experiments',
    alsoAt: ['/suites', '/configurations', '/resources/skills', '/system'],
  },
  {
    name: 'empty',
    domain: 'global',
    description:
      'Nothing exists yet: no experiments, no configurations, no skills, documents, MCP servers or secrets, and no suites in ./suites.',
    route: '/experiments',
    alsoAt: [
      '/suites',
      '/configurations',
      '/resources/skills',
      '/resources/documents',
      '/resources/mcp',
    ],
  },
  {
    name: 'stream-offline',
    domain: 'global',
    description: 'The summary stream has been down for 30 s: the AppShell shows Offline · Retry.',
    route: '/experiments',
    alsoAt: ['/system'],
  },

  // Experiments ---------------------------------------------------------------
  {
    name: 'first-launch',
    domain: 'experiments',
    description:
      'Flow A step 1: invoices-v1 is loaded but there are no configurations, experiments or resources ("1 suite loaded · 0 configurations").',
    route: '/experiments',
    alsoAt: ['/configurations', '/experiments/new'],
  },
  {
    name: 'paused-ceiling',
    domain: 'experiments',
    description:
      'MCP vs baseline paused at 15:08 when spend reached the $2.00 ceiling (87 / 120 scored, 32 waiting); Resume needs a higher ceiling (≈ $0.45 more to finish).',
    route: exp('mcpVsBaseline'),
    alsoAt: ['/experiments'],
  },
  {
    name: 'paused-provider',
    domain: 'experiments',
    description:
      'MCP vs baseline paused at 15:08: Nous Portal is not connected (87 of 120 scored, 0 running, 33 queued). Combine with nous-not-connected for the disabled Resume and Reconnect.',
    route: exp('mcpVsBaseline'),
    alsoAt: ['/experiments'],
  },
  {
    name: 'no-worker',
    domain: 'system',
    description:
      'No worker heartbeat since 15:31:04: the AppShell pill turns amber, System lists the worker offline, and MCP vs baseline shows the no-worker banner with 4 in-flight runs marked execution_error · worker_lost.',
    route: exp('mcpVsBaseline'),
    alsoAt: ['/system', '/suites/invoices-v1/save'],
  },
  {
    name: 'failed',
    domain: 'experiments',
    description:
      'MCP vs baseline, first try: stopped after 14 failed attempts in a row (setup), invoice-db failed to start, "Error: INVOICE_DB_URL is not set".',
    route: exp('mcpFirstTry'),
    baseData: true,
  },
  {
    name: 'single-rep',
    domain: 'experiments',
    description:
      'Skill vs no skill, quick check after it finished: 1 repetition, one cell per configuration, no Δ, "No interval with 1 repetition" (baseline 0.58, with-skill 0.75).',
    route: exp('quickCheck', '/comparison'),
    alsoAt: [exp('quickCheck')],
  },
  {
    name: 'multi-candidate',
    domain: 'experiments',
    description:
      'Skill + MCP, invoices-v1: two candidates, so the Comparison shows the candidate select (both provisional while it runs, as the API answers) and the Overview one VerdictCard each.',
    route: exp('skillMcp', '/comparison'),
    baseData: true,
  },
  {
    name: 'nothing-scored',
    domain: 'experiments',
    description:
      'MCP vs baseline just launched: 0 of 120 runs scored, 3 running. Comparison reads "Nothing to compare yet".',
    route: exp('mcpVsBaseline', '/comparison'),
    alsoAt: [exp('mcpVsBaseline')],
  },
  {
    name: 'verdict-updated',
    domain: 'experiments',
    description:
      'MCP smoke test after Flow B: currency_mix · with-mcp · rep 2 retried and passed; the verdict is recomputed to +0.083 [−0.056, +0.278] with "previously +0.056 [−0.111, +0.250]".',
    route: exp('mcpSmoke'),
    alsoAt: [exp('mcpSmoke', '/comparison')],
  },
  {
    name: 'stream-lost',
    domain: 'experiments',
    description:
      'For the live-stream layer: the experiment event stream drops; the LiveIndicator turns amber ("Reconnecting") and values freeze. Fixture data is unchanged.',
    route: exp('mcpVsBaseline'),
  },
  {
    name: 'launch-refused',
    domain: 'experiments',
    description:
      'The page still thought Nous Portal was connected: Launch is refused with "POST /api/experiments → 409 · Nous Portal is not connected" and the form keeps its values.',
    route: '/experiments/new',
  },
  {
    name: 'launch-conflict',
    domain: 'experiments',
    description:
      'Launch fails with "POST /api/experiments → 409 · configuration with-skill changed since you opened this form (now v2)".',
    route: '/experiments/new',
  },
  {
    name: 'no-history',
    domain: 'experiments',
    description:
      'No past runs on invoices-v1: New experiment estimates from the time budget ÷ 4 and 15,000 tokens per run.',
    route: '/experiments/new',
  },
  {
    name: 'bulk-refused',
    domain: 'experiments',
    description:
      'Bulk Re-score and Retry execution fail to enqueue: the ErrorBanner names every run that could not be enqueued.',
    route: exp('skillVsNoSkill', '/runs'),
  },

  // Run inspector ---------------------------------------------------------------
  {
    name: 'execution-error',
    domain: 'inspector',
    description:
      'disputed · baseline · rep 4 · attempt 2 of 2: execution_error · timeout, both attempts timed out at python3 reconcile.py; stderr tail and Retry execution.',
    route: run('skillVsNoSkill', 'disputed', 'baseline', 4),
    baseData: true,
  },
  {
    name: 'running',
    domain: 'inspector',
    description:
      'currency_mix · with-mcp · rep 5 · attempt 1, running: 14 events so far, the last invoice-db get_invoice still open; Cancel run instead of Re-score.',
    route: run('mcpVsBaseline', 'currency_mix', 'with-mcp', 5),
    baseData: true,
  },
  {
    name: 'cancelled',
    domain: 'inspector',
    description:
      'MCP vs baseline cancelled at 15:31:04: summary_file · with-mcp · rep 5 ran for 31 s, timeline ends "Cancelled at 00:31", partial summary.csv listed.',
    route: run('mcpVsBaseline', 'summary_file', 'with-mcp', 5),
    alsoAt: [exp('mcpVsBaseline')],
  },
  {
    name: 'ungradable',
    domain: 'inspector',
    description:
      'credit_notes · baseline · rep 2: no fenced JSON block found in final response; method still passed 0.80.',
    route: run('skillVsNoSkill', 'credit_notes', 'baseline', 2),
    baseData: true,
  },
  {
    name: 'score-error',
    domain: 'inspector',
    description:
      'credit_notes · with-skill · rep 4: the method llm_judge could not reach the provider (503 after 3 attempts); answer passed 1.00; Re-score in the header.',
    route: run('skillVsNoSkill', 'credit_notes', 'with-skill', 4),
    baseData: true,
  },
  {
    name: 'multi-attempt',
    domain: 'inspector',
    description:
      'disputed · baseline · rep 4 after Retry execution: attempt 2 of 2 scored (answer failed, rationale passed 0.75); "Attempts (2)" expander.',
    route: run('skillVsNoSkill', 'disputed', 'baseline', 4),
  },
  {
    name: 'disk-limit',
    domain: 'inspector',
    description:
      'summary_file · with-skill · rep 2: execution_error · other, "Stopped: the run wrote more than 2 GB to its workspace (disk limit)".',
    route: run('skillVsNoSkill', 'summary_file', 'with-skill', 2),
  },
  {
    name: 'token-cap',
    domain: 'inspector',
    description:
      'vat_split · with-mcp · rep 3 of the MCP smoke test: execution_error · limit, "Stopped at the token cap: 2,000,000 model tokens in this attempt"; never retried automatically.',
    route: run('mcpSmoke', 'vat_split', 'with-mcp', 3),
  },
  {
    name: 'timeout-silent',
    domain: 'inspector',
    description:
      'disputed · baseline · rep 4 · attempt 1: execution_error · timeout, the run printed nothing and was still stopped on time (310 s).',
    route: run('skillVsNoSkill', 'disputed', 'baseline', 4),
  },
  {
    name: 'provider-lapsed',
    domain: 'inspector',
    description:
      'late_fees · with-skill · rep 3 · attempt 2: execution_error · provider, the Nous Portal login lapsed; no attempt counted against the run.',
    route: run('skillVsNoSkill', 'late_fees', 'with-skill', 3),
  },
  {
    name: 'refused-by-sandbox',
    domain: 'inspector',
    description:
      "currency_mix · with-skill · rep 2: the agent's terminal curl to example.com:443 is refused (red sub-row on that tool call).",
    route: run('skillVsNoSkill', 'currency_mix', 'with-skill', 2),
    baseData: true,
  },
  {
    name: 'memory-files',
    domain: 'inspector',
    description:
      "per_vendor seeds the agent's memory (home/memories/MEMORY.md and USER.md): its runs list the memory files in a Memory group (MEMORY.md home seed · unchanged; USER.md home seed · modified where the answer passed), the launch record lists both seeds, and Task detail shows the seeds, the expected_home file and a file_check with root home.",
    route: run('skillVsNoSkill', 'per_vendor', 'with-skill', 1),
    alsoAt: [`/suites/${SUITE_V1_ID}/tasks/per_vendor`],
  },
  {
    name: 'sample-run',
    domain: 'inspector',
    description:
      'The inspector board run: dup_invoices · baseline · rep 3, answer failed ("expected 2 duplicate pairs, got 0"), 52 s, 11,400 in · 1,900 out.',
    route: exp('skillVsNoSkill', `/runs/${SAMPLE_RUN_ID}`),
    baseData: true,
  },

  {
    name: 'stderr-long',
    domain: 'inspector',
    description:
      'Full log on disputed · baseline · rep 4: the stderr.log is 3.3 MB, so only its last 1 MB comes back ("stderr · last 1 MB of 3.3 MB · 48,213 lines in all").',
    route: run('skillVsNoSkill', 'disputed', 'baseline', 4),
  },
  {
    name: 'stderr-missing',
    domain: 'inspector',
    description:
      'Full log answers 404: no log is stored for the attempt, which ended before the worker kept full logs; the stored tail stays.',
    route: run('skillVsNoSkill', 'disputed', 'baseline', 4),
  },
  {
    name: 'hermes-background',
    domain: 'inspector',
    description:
      "Every run's timeline also has Hermes's own background requests, origin hermes_background: a refused CONNECT to hermes-agent.nousresearch.com and an allowed one to raw.githubusercontent.com, both neutral and tagged Hermes background.",
    route: run('skillVsNoSkill', 'per_vendor', 'with-skill', 1),
  },
  {
    name: 'mcp-http',
    domain: 'inspector',
    description:
      'with-mcp runs call the http sample vendor-directory: its 405 to the event-stream GET is a neutral "MCP event stream not offered · vendor-directory · 405", and search_vendors\'s 31,204-character result is cut at the MCP window of 20,000 characters.',
    route: run('mcpVsBaseline', 'per_vendor', 'with-mcp', 1),
  },

  // Suites ----------------------------------------------------------------------
  {
    name: 'invalid-task',
    domain: 'suites',
    description:
      'Flow D: after a reload, invoices-v1 v2 (7d20e4b, was 3f9c2a1) has late_fees failing its self-check (11 / 12 valid); New experiment disables it; older experiments see the newer version.',
    route: `/suites/${SUITE_V2_ID}`,
    alsoAt: ['/suites', `/suites/${SUITE_V2_ID}/tasks/late_fees`, '/experiments/new'],
  },
  {
    name: 'reverted',
    domain: 'suites',
    description:
      'late_fees was reverted on disk: the directory points back at v1, shown "v1 (reverted)", with v2 in the history.',
    route: `/suites/${SUITE_V1_ID}`,
    alsoAt: ['/suites'],
  },
  {
    name: 'newer-version',
    domain: 'suites',
    description:
      'invoices-v1 v2 changed total_due (still valid): experiments on v1 say "A newer version of invoices-v1 exists (v2): 1 task changed (total_due)" with Duplicate on v2; task total_due shows v2 and its diff.',
    route: exp('skillVsNoSkill'),
    alsoAt: [`/suites/${SUITE_V2_ID}/tasks/total_due`],
  },
  {
    name: 'diff-not-recorded',
    domain: 'suites',
    description:
      'With newer-version (?scenario=newer-version,diff-not-recorded): total_due v1 was loaded before Phase 5b, so the diff\'s reference.json reads "not recorded → 47 B" for its size and hash instead of a dash.',
    route: `/suites/${SUITE_V2_ID}/tasks/total_due?diff=${SUITE_V1_ID}`,
  },
  {
    name: 'reload-failed',
    domain: 'suites',
    description:
      'Reload fails: "./suites/invoices-v1/vat_split/task.yaml:14:9 · mapping values are not allowed here"; the suite still serves v1 (3f9c2a1).',
    route: '/suites',
  },
  // Suite authoring (Phase 5b): the pages around the editor, then the draft and the editor.
  ...SUITE_AUTHORING_SCENARIOS,
  ...DRAFT_SCENARIOS,

  // Library -------------------------------------------------------------------------
  {
    name: 'upload-invalid',
    domain: 'library',
    description:
      'Skill upload validation fails: no SKILL.md at the zip root and no version in metadata; Confirm stays disabled.',
    route: '/resources/skills',
  },
  {
    name: 'upload-new-version',
    domain: 'library',
    description:
      'invoice-method 1.0.0 exists and the upload declares 1.1.0: allowed, Confirm reads "Upload as 1.1.0".',
    route: '/resources/skills',
  },
  {
    name: 'upload-same-version-different-hash',
    domain: 'library',
    description:
      'The upload declares 1.0.0 again with a different hash: "Bump version: in SKILL.md", Confirm stays disabled.',
    route: '/resources/skills',
  },
  {
    name: 'document-in-older-version',
    domain: 'library',
    description:
      'vendor-policy-v3.pdf is attached to no configuration now, but an older version of with-skill has it: "None now · kept by an older version of with-skill", and Delete is disabled with the reason.',
    route: '/resources/documents',
  },
  {
    name: 'mcp-test-failed',
    domain: 'library',
    description:
      'Test start of invoice-db exits with code 1 after 0.6 s ("Error: INVOICE_DB_URL is not set"); Secrets shows INVOICE_DB_URL not set.',
    route: '/resources/mcp',
    alsoAt: ['/resources/secrets', '/experiments/new'],
  },
  {
    name: 'secret-not-set',
    domain: 'library',
    description:
      'INVOICE_DB_URL is not set in the worker environment: the Secrets row reads "not set" with its warning, Test start fails, and New experiment tags with-mcp "INVOICE_DB_URL not set" and disables Launch with "with-mcp: INVOICE_DB_URL (invoice-db, read by the worker) is not set".',
    route: '/resources/secrets',
    alsoAt: ['/resources/mcp', '/experiments/new'],
  },
  {
    name: 'skills-on-demand',
    domain: 'library',
    description:
      "with-skill v1 loads invoice-method on demand: the form's Skill loading reads on demand, the detail and the diff show it (skill_loading preload → on demand), and its runs launch without -s, with the skills toolset.",
    route: `/configurations/${CONFIG_IDS['with-skill']}/edit`,
    alsoAt: [
      `/configurations/${CONFIG_IDS['with-skill']}`,
      '/configurations',
      '/experiments/new',
      run('skillVsNoSkill', 'dup_invoices', 'with-skill', 3),
    ],
  },

  // System (defined in src/fixtures/system.ts) -----------------------------------------
  {
    name: 'nous-connected',
    domain: 'system',
    description: 'Nous Portal connected (the default).',
    route: '/system',
  },
  {
    name: 'nous-not-connected',
    domain: 'system',
    description:
      'Nous Portal not connected: AppShell banner, SetupCard on Experiments, blockers on New experiment, run controls disabled through BlockedReason.',
    route: '/system',
    alsoAt: ['/experiments', '/experiments/new', exp('skillVsNoSkill', '/runs')],
  },
  {
    name: 'nous-waiting',
    domain: 'system',
    description: 'A Nous login waits for approval (code K7QD-P2MX, countdown, ApprovalPill).',
    route: '/system',
  },
  {
    name: 'nous-renewal',
    domain: 'system',
    description: 'The Nous login needs renewing; dependent experiments pause; renewal banner.',
    route: '/system',
  },
  {
    name: 'nous-expired',
    domain: 'system',
    description: 'The device code expired before approval: Get a new code.',
    route: '/system',
  },
  {
    name: 'nous-declined',
    domain: 'system',
    description: 'The login was declined in Nous Portal: Try again.',
    route: '/system',
  },
  {
    name: 'nous-subscription',
    domain: 'system',
    description: 'Nous Portal needs a subscription: link to billing.',
    route: '/system',
  },
  {
    name: 'nous-failed',
    domain: 'system',
    description: 'Nous Portal unreachable: Try again.',
    route: '/system',
  },
  {
    name: 'nous-host',
    domain: 'system',
    description: "Development login: this machine's Hermes login, no Connect button.",
    route: '/system',
  },
  {
    name: 'nous-host-down',
    domain: 'system',
    description: 'Development login, but hermes proxy is not running on the host.',
    route: '/system',
  },
  {
    name: 'nous-login-approve',
    domain: 'system',
    description: 'A login started from the UI is approved by itself after 6 s.',
    route: '/system',
  },
  {
    name: 'nous-login-decline',
    domain: 'system',
    description: 'A login started from the UI is declined after 6 s.',
    route: '/system',
  },
  {
    name: 'nous-login-expire',
    domain: 'system',
    description: 'A login started from the UI gets a code with 10 s left, which runs out.',
    route: '/system',
  },
  {
    name: 'nous-login-subscription',
    domain: 'system',
    description: 'A login started from the UI ends with needs subscription after 6 s.',
    route: '/system',
  },
  {
    name: 'nous-login-fail',
    domain: 'system',
    description: 'A login started from the UI fails after 6 s.',
    route: '/system',
  },
  {
    name: 'openrouter-missing',
    domain: 'system',
    description:
      'OPENROUTER_API_KEY is not set on the server (the default): the row shows the command to set it.',
    route: '/system',
  },
  {
    name: 'openrouter-configured',
    domain: 'system',
    description: 'OPENROUTER_API_KEY is set on the server.',
    route: '/system',
  },
  {
    name: 'nous-unavailable',
    domain: 'system',
    description:
      'The Nous login service failed its startup check: the row offers the terminal login, Connect opens the manual step and the banner opens System.',
    route: '/system',
  },
  {
    name: 'openrouter-in-use',
    domain: 'system',
    description:
      "The configurations use only OpenRouter, which has no key: the missing-key SetupCard, the no-key banner, ProviderNotice's server step, and New experiment's tagged rows and .env blocker.",
    route: '/experiments',
    alsoAt: ['/system', '/configurations/new', '/experiments/new'],
  },
  {
    name: 'sandbox-failed',
    domain: 'system',
    description:
      '2 of the 16 sandbox isolation checks fail (15 trial checks and the verifier container); the selftest command to re-run them.',
    route: '/system',
  },
  {
    name: 'sandbox-verifier-refused',
    domain: 'system',
    description:
      "The 16th isolation check fails: docker-guard refuses the verifier container's spec, so execution is disabled at worker start rather than at the first load or score (Phase 5b question 3).",
    route: '/system',
  },
  {
    name: 'nothing-running',
    domain: 'system',
    description: 'No experiment is running: the AppShell live pill is hidden.',
    route: '/system',
  },

  // First-run setup (Phase 8): the judge, the samples seed, the sample experiment, the
  // unfenced answer.
  ...PHASE8_SCENARIOS,
];

export function scenarioEntry(name: string): ScenarioEntry | undefined {
  return SCENARIOS.find((s) => s.name === name);
}

/** The route of a scenario with its ?scenario= parameter. */
export function scenarioUrl(entry: ScenarioEntry): string {
  return `${entry.route}${entry.route.includes('?') ? '&' : '?'}scenario=${entry.name}`;
}
