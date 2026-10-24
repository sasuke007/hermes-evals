/**
 * The last "Test start" result as mcp_server_versions.last_test stores it.
 *
 * It is the shared McpTestState plus one field the view needs and the shared
 * record lacks: `exit_code` on a failed test (McpTestView.exitCode). Optional,
 * so rows written before it parse, and every record here is still a valid
 * McpTestState for readers that do not know the field.
 */
import { z } from 'zod';
import { McpTestStateSchema } from '@hermes-evals/shared';

const [untested, running, passed, failed] = McpTestStateSchema.options;

// Fails to compile if the shared union's variants are ever reordered.
const variantOrder: [
  z.infer<typeof untested>['status'],
  z.infer<typeof running>['status'],
  z.infer<typeof passed>['status'],
  z.infer<typeof failed>['status'],
] = ['untested', 'running', 'passed', 'failed'];
void variantOrder;

export const McpTestRecordSchema = z.discriminatedUnion('status', [
  untested,
  running,
  passed,
  failed.extend({
    /** Exit code of `hermes mcp test`; null when no container ran or it was stopped. */
    exit_code: z.number().int().nullable().optional(),
  }),
]);
export type McpTestRecord = z.infer<typeof McpTestRecordSchema>;
export type FinishedMcpTestRecord = Extract<McpTestRecord, { status: 'passed' | 'failed' }>;

/** A stored last_test, or `untested` if it does not parse (it never should: the API and worker write it). */
export function readTestRecord(value: unknown): McpTestRecord {
  const parsed = McpTestRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : { status: 'untested' };
}
