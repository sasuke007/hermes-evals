/**
 * System: the running summary (with the workers), the sandbox self-test, and the live
 * summary stream. The example of the data-layer convention (src/api/README.md): live mode
 * calls the endpoint through apiGet with the response's shared schema; fixtures mode serves
 * src/fixtures/system.ts through fixture(), named after the request it stands in for.
 */
import { SystemEventSchema } from '@hermes-evals/shared';
import { apiGet } from './client';
import { apiMode, fixture, livePath } from './source';
import {
  SandboxStatusSchema,
  SystemSetupSchema,
  SystemSummarySchema,
  type SandboxStatus,
  type SystemSetup,
  type SystemSummary,
} from './types/system';

export { SystemEventSchema };

/** GET /system/summary: running experiments { count, scored, total }, workers, queued runs. */
export function getSystemSummary(): Promise<SystemSummary> {
  if (apiMode === 'live') return apiGet('/system/summary', SystemSummarySchema);
  return fixture((w) => w.system.systemSummaryFixture(), { request: 'GET /api/system/summary' });
}

/**
 * GET /system/sandbox: the worker's start-up self-test, 15 trial checks and, since Phase 7,
 * one verifier container started through docker-guard.
 */
export function getSandboxStatus(): Promise<SandboxStatus> {
  if (apiMode === 'live') return apiGet('/system/sandbox', SandboxStatusSchema);
  return fixture((w) => w.system.sandboxFixture(), { request: 'GET /api/system/sandbox' });
}

/**
 * GET /system/setup (Phase 8): the LLM judge (and whether it is the mock model), and what this
 * API start's samples seed created, skipped or failed. It changes only while the seed runs.
 */
export function getSystemSetup(): Promise<SystemSetup> {
  if (apiMode === 'live') return apiGet('/system/setup', SystemSetupSchema);
  return fixture((w) => w.setup.systemSetupFixture(), { request: 'GET /api/system/setup' });
}

/**
 * GET /system/events (SSE): a `summary` event on connect and every 5 s. Null in fixtures
 * mode, where the store polls getSystemSummary() instead. Use with useSse and
 * SystemEventSchema, listening for SYSTEM_EVENT_NAMES.
 */
export const systemEventsPath = livePath('/system/events');
export const SYSTEM_EVENT_NAMES = ['summary'] as const;
