/**
 * The platform's LLM judge as the pages see it, and the warning New
 * experiment and the launch answer give when the judge is the mock model
 * (Phase 8 G2).
 *
 * Since Phase 8, Compose starts the scripted mock model on every start and
 * makes it the judge unless JUDGE_* are set, so a fresh clone grades its
 * samples for free. On a real model's answers its llm_judge scores mean
 * nothing, so the pages say so; they never block on it.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { PROVIDERS, type Provider } from '../vocab.js';

// ---------------------------------------------------------------------------
// The mock model
// ---------------------------------------------------------------------------

/** The scripted mock model's Compose service: the host of its base URL. */
export const MOCK_MODEL_HOST = 'mock-model';
/** The mock model's base URL on the Compose network, for provider `custom`. */
export const MOCK_MODEL_BASE_URL = 'http://mock-model:8090/v1';
/** The model name the samples and smokes give the mock. It answers any name. */
export const MOCK_MODEL_NAME = 'mock/scripted';

/**
 * Whether a route goes to the mock model: provider `custom` with a base URL
 * on MOCK_MODEL_HOST, whatever its port or path. The model name does not
 * count, since the mock answers any name and a real endpoint could use
 * `mock/scripted` too. Any other provider, or a custom endpoint elsewhere,
 * is a real model.
 */
export function isMockModelRoute(route: {
  provider: Provider;
  baseUrl: string | null | undefined;
}): boolean {
  if (route.provider !== 'custom' || !route.baseUrl) return false;
  // Scheme, host, optional port, then the path or nothing. A URL with
  // user:password@ does not match: neither base URL setting allows one.
  const host = /^https?:\/\/([^/?#@\s:]+)(?::\d+)?(?:[/?#]|$)/i.exec(route.baseUrl.trim())?.[1];
  return host?.toLowerCase() === MOCK_MODEL_HOST;
}

// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

/**
 * The platform judge (JUDGE_PROVIDER, JUDGE_MODEL, JUDGE_BASE_URL), on
 * New experiment's options and on System. Never the base URL itself, nor
 * any key.
 */
export const JudgeViewSchema = z.object({
  /**
   * JUDGE_PROVIDER, or `nous` when it is unset: where every judge call goes,
   * a check's own `model:` included.
   */
  provider: z.enum(PROVIDERS),
  /**
   * JUDGE_MODEL, the model of every llm_judge check that names none. Null
   * when unset: only checks with their own `model:` are graded, and launch
   * answers 409 for a task whose check has neither.
   */
  model: z.string().nullable(),
  /** The judge's calls go to the scripted mock model (isMockModelRoute on JUDGE_PROVIDER and JUDGE_BASE_URL). */
  mock: z.boolean(),
  /**
   * JUDGE_MODEL is the mock model's name (MOCK_MODEL_NAME) but the judge's
   * calls do not go to the mock: a `custom` JUDGE_BASE_URL elsewhere with
   * Compose's default model left beside it, which a real endpoint answers
   * with an error. The pages warn (MOCK_MODEL_NAME_JUDGE_WARNING) rather than
   * read the model as unset, since a mock reached at another host answers
   * it. Never true beside another provider: env.ts reads the name as unset
   * there.
   */
  mockModelName: z.boolean(),
});
export type JudgeView = z.infer<typeof JudgeViewSchema>;

/** New experiment's warning, and the launch answer's, when the mock would judge a real model. */
export const MOCK_JUDGE_WARNING =
  'The LLM judge is the mock model, so llm_judge checks will not mean anything on a real model. Set JUDGE_PROVIDER and JUDGE_MODEL in .env.';

/** The same places' warning when the judge's model is the mock's name on a route that is not the mock. */
export const MOCK_MODEL_NAME_JUDGE_WARNING = `The LLM judge's model is ${MOCK_MODEL_NAME}, the mock model's name, but JUDGE_BASE_URL is not the mock model: a real endpoint will fail every llm_judge check that names no model. Set JUDGE_MODEL in .env.`;

/**
 * The judge's warning for a launch, or null; a warning, never a block. With
 * a selected task that has an llm_judge check: MOCK_MODEL_NAME_JUDGE_WARNING
 * when the judge's model is the mock's name on another route, whatever the
 * configurations; MOCK_JUDGE_WARNING when the judge is the mock and one of
 * the chosen configurations (baseline or candidate) runs a real model. New
 * experiment calls it as the user chooses (on its options' `judge`,
 * configurations' `mockModel` and tasks' `hasLlmJudge`), and the launch
 * with the same values, so the two always agree.
 */
export function mockJudgeWarning(
  judge: Pick<JudgeView, 'mock' | 'mockModelName'>,
  configurations: ReadonlyArray<{ mockModel: boolean }>,
  tasks: ReadonlyArray<{ hasLlmJudge: boolean }>,
): string | null {
  if (!tasks.some((t) => t.hasLlmJudge)) return null;
  if (judge.mockModelName) return MOCK_MODEL_NAME_JUDGE_WARNING;
  return judge.mock && configurations.some((c) => !c.mockModel) ? MOCK_JUDGE_WARNING : null;
}
