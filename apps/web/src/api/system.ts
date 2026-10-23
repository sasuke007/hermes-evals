/**
 * System: API health, the running summary and workers, and the sandbox self-test.
 * Health always calls the API (GET /api/health exists). The rest serve fixtures by default
 * (src/fixtures/system.ts); VITE_API_MODE=live calls the planned endpoints.
 */
import { HealthResponseSchema, type HealthResponse } from '@hermes-evals/shared';
import { apiGet } from './client';
import { apiMode, fixture } from './source';
import {
  SandboxStatusSchema,
  SystemSummarySchema,
  WorkerSchema,
  type SandboxStatus,
  type SystemSummary,
  type Worker,
} from './types/system';
import { sandboxFixture, systemSummaryFixture, workersFixture } from '@/fixtures/system';

export function getHealth(): Promise<HealthResponse> {
  return apiGet('/health', HealthResponseSchema);
}

/** GET /system/summary: running experiments { count, scored, total }, workers, queued runs. */
export function getSystemSummary(): Promise<SystemSummary> {
  if (apiMode === 'live') return apiGet('/system/summary', SystemSummarySchema);
  return fixture(systemSummaryFixture, { request: 'GET /api/system/summary' });
}

/** GET /system/workers: heartbeat, concurrency, slots and sandbox proof per worker. */
export function listWorkers(): Promise<Worker[]> {
  if (apiMode === 'live') return apiGet('/system/workers', WorkerSchema.array());
  return fixture(workersFixture, { request: 'GET /api/system/workers' });
}

/** GET /system/sandbox: the 15 isolation checks from the worker's start-up self-test. */
export function getSandboxStatus(): Promise<SandboxStatus> {
  if (apiMode === 'live') return apiGet('/system/sandbox', SandboxStatusSchema);
  return fixture(sandboxFixture, { request: 'GET /api/system/sandbox' });
}
