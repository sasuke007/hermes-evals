import { z } from 'zod';

const CheckSchema = z.enum(['ok', 'unavailable', 'not_configured']);

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.object({
    database: CheckSchema,
    /** Schema migrations applied at boot. */
    migrations: CheckSchema,
    queue: CheckSchema,
  }),
  timestamp: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
