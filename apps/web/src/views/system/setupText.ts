/**
 * What System › Judge and samples says (Phase 8 G2, G3), as pure functions of GET
 * /system/setup: the judge's line, and the samples seed's summary.
 */
import {
  MOCK_MODEL_NAME,
  seedCounts,
  type JudgeView,
  type SeedItemKind,
  type SeedReport,
} from '@hermes-evals/shared';
import { formatClock, plural } from '@/lib/format';

/** The services that read JUDGE_* and SEED_SAMPLES: recreated, they read .env again. */
export const SETUP_APPLY_COMMAND = 'docker compose up -d api worker';

/** "custom · mock/scripted", or "nous · no model" while JUDGE_MODEL is unset. */
export function judgeSetting(judge: JudgeView): string {
  return `${judge.provider} · ${judge.model ?? 'no model'}`;
}

/** The judge's status chip: the mock model, the mock's model name elsewhere, or a real judge. */
export function judgeStatus(judge: JudgeView): 'mock' | 'mock_name' | 'real' {
  if (judge.mock) return 'mock';
  return judge.mockModelName ? 'mock_name' : 'real';
}

/** The judge row's sentence: what its llm_judge scores are worth, and how to change it. */
export function judgeDetail(judge: JudgeView): string {
  if (judge.mockModelName) {
    return `JUDGE_MODEL is ${MOCK_MODEL_NAME}, the mock model's name, but JUDGE_BASE_URL is not the mock model: a real endpoint fails every llm_judge check that names no model. Set JUDGE_MODEL in .env.`;
  }
  if (judge.mock) {
    return "The scripted mock model grades llm_judge checks: right for the samples on the mock model, meaningless on a real model's answers. For a real judge, set JUDGE_PROVIDER and JUDGE_MODEL in .env.";
  }
  if (judge.model === null) {
    return 'JUDGE_MODEL is not set: only llm_judge checks that name their own model are graded, and a launch with one that names none is refused.';
  }
  return `llm_judge checks that name no model of their own are graded by ${judge.model} through ${judge.provider}.`;
}

/** The seed row's sentence, by its state. */
export function seedDetail(seed: SeedReport): string {
  switch (seed.state) {
    case 'off':
      return 'SEED_SAMPLES is off, so this start added no samples.';
    case 'running':
      return `Adding the samples since ${formatClock(seed.startedAt)}: ${plural(seed.items.length, 'sample')} so far.`;
    case 'failed':
      return `Stopped at ${formatClock(seed.finishedAt)}, after ${plural(seed.items.length, 'sample')}. The API runs on without the rest.`;
    case 'done': {
      const { created, skipped, failed } = seedCounts(seed);
      return `${created} created · ${skipped} skipped · ${failed} failed, at ${formatClock(seed.finishedAt)}.`;
    }
  }
}

/** A seed item's kind as a column reads it. */
export const SEED_KIND_LABELS: Record<SeedItemKind, string> = {
  skill: 'Skill',
  document: 'Document',
  mcp_server: 'MCP server',
  configuration: 'Configuration',
};
