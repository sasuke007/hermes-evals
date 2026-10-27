/**
 * Model access, sandbox and worker contracts (plan section 6.1 and section 11), and the
 * platform's setup (Phase 8): the judge and the samples seed.
 * The platform never sees a token: a login is only a user code, a link, an expiry and a state.
 *
 * The schemas live in @hermes-evals/shared and are re-exported here; the live
 * API calls validate with them and the fixtures are typed by them.
 */
export {
  AUTH_METHODS,
  JudgeViewSchema,
  KEY_PROVIDER_STATUSES,
  NOUS_LOGIN_STATES,
  NOUS_STATUSES,
  NousLoginSchema,
  PROVIDER_STATUSES,
  ProviderInfoSchema,
  ProvidersResponseSchema,
  RunningExperimentSchema,
  RunningSummarySchema,
  SandboxCheckSchema,
  SandboxStatusSchema,
  SEED_ITEM_KINDS,
  SEED_OUTCOMES,
  SEED_STATES,
  SeedItemSchema,
  SeedReportSchema,
  SystemSetupSchema,
  SystemSummarySchema,
  WORKER_TIMEOUT_MS,
  WorkerSchema,
} from '@hermes-evals/shared';
export type {
  AuthMethod,
  JudgeView,
  KeyProviderStatus,
  NousLogin,
  NousLoginState,
  NousStatus,
  ProviderInfo,
  ProviderStatus,
  RunningExperiment,
  RunningSummary,
  SandboxCheck,
  SandboxStatus,
  SeedItem,
  SeedItemKind,
  SeedOutcome,
  SeedReport,
  SeedState,
  SystemSetup,
  SystemSummary,
  Worker,
} from '@hermes-evals/shared';
