/**
 * Facts about the pinned Hermes runtime every trial runs (plan sections 2
 * and 8.2). The trial image is nousresearch/hermes-agent:v0.22.4 pinned by
 * digest; these constants are what that image reports.
 */

export const HERMES_VERSION = '0.22.4';
/** Full git sha of the Hermes revision baked into the trial image. */
export const HERMES_REVISION = '4d04303818b61bf3aa09278af48356315515965b';

/**
 * The built-in toolsets `hermes tools list` reports as enabled in the trial
 * image, in the runtime's order (verified 24 Oct 2026 by running the image
 * offline). The worker reads the live list from the image at start and
 * stores it on its `workers` row; this list is the fallback when no worker
 * has reported one yet.
 */
export const HERMES_TOOLSETS = [
  'web',
  'browser',
  'terminal',
  'file',
  'code_execution',
  'vision',
  'image_gen',
  'tts',
  'skills',
  'todo',
  'memory',
  'session_search',
  'connections',
  'clarify',
  'delegation',
  'cronjob',
  'computer_use',
] as const;

/** Toolsets a new configuration starts with. */
export const DEFAULT_TOOLSETS = ['file', 'terminal'] as const;

/**
 * Hosts Hermes contacts by itself rather than for the agent, as the
 * platform has seen them (Phase 7): the credits-seed pricing fetch every
 * `nous` run makes to inference-api.nousresearch.com (plan 8.2, spike I10),
 * and the requests to hermes-agent.nousresearch.com and
 * raw.githubusercontent.com that Phase 5 saw refused (Phase 5 section 6.2).
 * Egress labels a connection or call to one of them with origin
 * `hermes_background` (NETWORK_ORIGINS), and the inspector draws it neutral.
 * Egress keeps its own copy of the list, since it does not depend on this
 * package. Lower case; compare host names lower-cased.
 */
export const HERMES_BACKGROUND_HOSTS = [
  'inference-api.nousresearch.com',
  'hermes-agent.nousresearch.com',
  'raw.githubusercontent.com',
] as const;

/** Whether `host` (any case, no port) is one of HERMES_BACKGROUND_HOSTS. */
export const isHermesBackgroundHost = (host: string): boolean =>
  (HERMES_BACKGROUND_HOSTS as readonly string[]).includes(host.toLowerCase());
