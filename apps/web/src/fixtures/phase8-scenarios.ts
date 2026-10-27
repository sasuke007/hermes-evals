/**
 * The scenarios of Phase 8's first-run setup (scenarios.ts lists them all): the judge, the
 * samples seed, the sample experiment, and the unfenced answer. The setup ones are served by
 * ./setup.ts, the sample configurations by ./samples.ts, the unfenced answer by
 * ./inspector-answers.ts.
 */
import { EXPERIMENT_IDS } from './experiments';
import { UNFENCED_RUN } from './inspector-answers';
import { runIdOf } from './inspector';
import type { ScenarioEntry } from './scenarios';

const unfencedRun = () => {
  const id = EXPERIMENT_IDS[UNFENCED_RUN.experiment];
  const run = runIdOf(
    () => false,
    id,
    UNFENCED_RUN.task,
    UNFENCED_RUN.config,
    UNFENCED_RUN.repetition,
  );
  return `/experiments/${id}/runs/${run ?? ''}`;
};

export const PHASE8_SCENARIOS: ScenarioEntry[] = [
  {
    name: 'samples-seeded',
    domain: 'experiments',
    description:
      'A fresh clone after its first start: no experiment yet, the mock model judges, and the seed made invoices-v1-baseline-mock and invoices-v1-with-skill-mock, so the empty list offers Run a sample experiment (2 repetitions of every valid task). New experiment offers it too.',
    route: '/experiments',
    alsoAt: ['/experiments/new', '/system'],
  },
  {
    name: 'judge-mock',
    domain: 'system',
    description:
      'The LLM judge is the scripted mock model (custom · mock/scripted): System marks it, and New experiment warns, without blocking, once a real model meets a selected llm_judge check; the launch answer carries the same warning to the Overview.',
    route: '/system',
    alsoAt: ['/experiments/new'],
  },
  {
    name: 'judge-mock-name',
    domain: 'system',
    description:
      "The judge is a custom endpoint that is not the mock, but JUDGE_MODEL is Compose's default, mock/scripted, which a real endpoint fails: System says check model, and New experiment warns on any selected llm_judge check, whatever the configurations.",
    route: '/system',
    alsoAt: ['/experiments/new'],
  },
  {
    name: 'seed-running',
    domain: 'system',
    description:
      'The samples seed of this API start is still going (2 samples so far); System reads the setup again every 2 s until it ends.',
    route: '/system',
  },
  {
    name: 'seed-item-failed',
    domain: 'system',
    description:
      'The seed finished, but the service refused mcp-v1-with-mcp-mock ("MCP server vendor-directory does not exist"): System opens the samples list with that row in red.',
    route: '/system',
  },
  {
    name: 'seed-failed',
    domain: 'system',
    description:
      'The seed stopped before it added anything: the samples folder is not in the api container. The API runs on; System shows the reason.',
    route: '/system',
  },
  {
    name: 'seed-off',
    domain: 'system',
    description: 'SEED_SAMPLES is false: System says this start added no samples.',
    route: '/system',
  },
  {
    name: 'unfenced-answer',
    domain: 'inspector',
    description:
      'dup_invoices · with-skill · rep 1 replied with one JSON object and no ```json fence: the inspector says "Unfenced answer" and highlights the whole reply as extracted.',
    route: unfencedRun(),
  },
];
