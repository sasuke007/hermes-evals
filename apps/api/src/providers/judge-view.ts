/**
 * The platform judge as the pages see it (Phase 8 G2): its provider, its
 * default model and whether its calls go to the scripted mock model. New
 * experiment's options carry it, so the form can warn as the user chooses,
 * the launch answer warns with the same rule (shared mockJudgeWarning), and
 * the System page shows it.
 *
 * Compose makes the mock the judge unless JUDGE_* are set, so a fresh clone
 * grades its samples for free. On a real model's answers the mock's scores
 * mean nothing, hence the warning; it never blocks a launch.
 *
 * The provider follows resolveJudgeModel's rule (JUDGE_PROVIDER, or `nous`
 * when unset), the one the scorer and the launch's readiness check use. The
 * base URL itself is never shown: only whether it is the mock's.
 *
 * Compose defaults each JUDGE_* setting on its own, so a `custom` judge set
 * in .env with a real JUDGE_BASE_URL and no JUDGE_MODEL still has the mock's
 * model name: `mockModelName` says so, and the pages warn. (Beside any other
 * provider env.ts reads that name as unset, and the launch refuses as it
 * does for no model.)
 */
import type { ConfigService } from '@nestjs/config';
import {
  isMockModelRoute,
  MOCK_MODEL_NAME,
  type JudgeView,
  type VerificationEntry,
} from '@hermes-evals/shared';
import type { Env } from '../config/env.js';
import { judgeSettingsFrom } from '../runs/judge-needs.js';
import { DEFAULT_JUDGE_PROVIDER, type JudgeSettings } from '../scoring/judge/contracts.js';

/** The judge of these settings, as JudgeViewSchema shows it. */
export function judgeView(settings: JudgeSettings): JudgeView {
  const provider = settings.provider ?? DEFAULT_JUDGE_PROVIDER;
  const model = settings.model?.trim() || null;
  const mock = isMockModelRoute({ provider, baseUrl: settings.baseUrl });
  return { provider, model, mock, mockModelName: !mock && model === MOCK_MODEL_NAME };
}

/** The judge of the process's settings (JUDGE_PROVIDER, JUDGE_MODEL, JUDGE_BASE_URL). */
export const judgeViewFrom = (config: Pick<ConfigService<Env, true>, 'get'>): JudgeView =>
  judgeView(judgeSettingsFrom(config));

/**
 * Whether a task has an llm_judge key: one the judge grades, whatever model
 * it names, since every judge call goes to the judge's provider and route.
 */
export const hasLlmJudge = (verification: ReadonlyArray<Pick<VerificationEntry, 'type'>>) =>
  verification.some((entry) => entry.type === 'llm_judge');
