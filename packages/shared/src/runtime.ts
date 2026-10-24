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
