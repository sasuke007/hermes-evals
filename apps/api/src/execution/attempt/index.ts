/**
 * The attempt runner (plan 5.4, 8.2 to 8.5). The lifecycle builds one
 * TrialAttemptRunner per worker and calls run(plan, sink, signal) per
 * attempt; see contracts.ts for the seam.
 */
export { classifyAttempt, type AttemptObservation, type Classification } from './classify.js';
export { AttemptSetupError } from './errors.js';
export {
  ATTEMPT_TOKEN_PLACEHOLDER,
  buildTrialLaunch,
  hermesChatCmd,
  trialEnv,
  type AttemptLaunchRecord,
} from './launch.js';
export { TrialAttemptRunner, type AttemptLogger, type AttemptRunnerDeps } from './runner.js';
export {
  DEFAULT_RUNNER_SETTINGS,
  IMAGE_DEFAULT_PATH,
  type AttemptRunnerSettings,
  type TokenCheck,
} from './settings.js';
export {
  attemptConfig,
  configYaml,
  displayConfigYaml,
  hermesConfig,
  TRIAL_CONFIG_PATH,
} from './trial-config.js';
