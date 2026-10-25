/**
 * Lines recorded from the real Hermes, copied verbatim from
 * src/execution/stream-json.spec.ts, where their provenance is described:
 * trial image hermes-evals/trial:v0.22.4-4d04303 on 24 Oct 2026, `hermes chat
 * --oneshot --format stream-json --provider custom` with no network, against
 * a scripted model inside the container, with the invoice-db stdio MCP
 * server configured. The model called invoice-db's get_invoice, then the
 * terminal, then answered.
 *
 * Test-only: the name ends in `spec.ts` so the build leaves it out, but not
 * in `.spec.ts`, so vitest does not run it as a test file.
 */
import { parseStreamLine } from '../../execution/stream-json.js';
import type { EventRecord } from './rows.js';

export const RECORDED_RUN: readonly string[] = [
  '{"type": "system", "subtype": "init", "model": "mock/scripted", "session_id": "", "timestamp": 1792856095707}',
  '{"type": "tool_use", "name": "mcp__invoice_db__get_invoice", "tool_call_id": "call_0", "input": {"invoice_no": "INV-1001"}, "timestamp": 1792856101405}',
  '{"type": "tool_result", "name": "mcp__invoice_db__get_invoice", "tool_call_id": "call_0", "output": "{\\"result\\": \\"{\\\\n  \\\\\\"invoice_no\\\\\\": \\\\\\"INV-1001\\\\\\",\\\\n  \\\\\\"vendor_name\\\\\\": \\\\\\"Acme Supplies\\\\\\",\\\\n  \\\\\\"invoice_date\\\\\\": \\\\\\"2026-09-01\\\\\\",\\\\n  \\\\\\"due_date\\\\\\": \\\\\\"2026-10-01\\\\\\",\\\\n  \\\\\\"amount\\\\\\": 1250.0,\\\\n  \\\\\\"currency\\\\\\": \\\\\\"EUR\\\\\\",\\\\n  \\\\\\"po_number\\\\\\": \\\\\\"PO-501\\\\\\",\\\\n  \\\\\\"status\\\\\\": \\\\\\"paid\\\\\\"\\\\n}\\"}", "duration_ms": 7, "is_error": false, "timestamp": 1792856101412}',
  '{"type": "tool_use", "name": "terminal", "tool_call_id": "call_1", "input": {"command": "echo hello > /tmp/ws/out.txt && cat /tmp/ws/out.txt"}, "timestamp": 1792856101427}',
  '{"type": "tool_result", "name": "terminal", "tool_call_id": "call_1", "output": "{\\"output\\": \\"hello\\", \\"exit_code\\": 0, \\"error\\": null}", "duration_ms": 40, "is_error": false, "timestamp": 1792856101468}',
  '{"type": "text", "text": "\\n\\nTotal done.\\n```json\\n{\\"total\\": 1042}\\n```", "timestamp": 1792856101472}',
  '{"type": "result", "session_id": "local-f6da07ee3ed16bbdcd806ce8eca2ad19202848887fc6edbdeea8291ccf97119b", "exit_code": 0, "text": "Total done.\\n```json\\n{\\"total\\": 1042}\\n```", "tokens": {"input": 3300, "output": 63, "total": 3363, "cache_read": 1200, "cache_write": 0}, "duration_ms": 5789, "timestamp": 1792856101496}',
];

/** The same run with the model unreachable: Hermes retried for 304 s, then gave up. */
export const RECORDED_PROVIDER_FAILURE =
  '{"type": "result", "session_id": "local-d994ca8d9d23f8eba268cff6ad647d3ba39a3d3aa5d8e87d2349c077f3a13af0", "exit_code": 1, "text": "custom didn\'t respond in time on any of 3 attempts — it looks temporarily unavailable. Wait a minute and send /retry, or switch models with /model. To avoid this in future, add a backup provider with `hermes fallback add`.\\n\\nProvider said: Connection error.\\n\\nYour request was not processed. Send it again if you still want me to carry it out.", "tokens": {"input": 0, "output": 0, "total": 0, "cache_read": 0, "cache_write": 0}, "duration_ms": 303856, "error": "Connection error.", "timestamp": 1792856407701}';

/** The epoch ms of the recorded run's first line (its init event). */
export const RECORDED_START_MS = 1_792_856_095_707;

/** Stored events, numbered from `firstSeq`, as the worker writes the lines through parseStreamLine. */
export function recordedEvents(
  lines: readonly string[] = RECORDED_RUN,
  firstSeq = 1,
): EventRecord[] {
  return lines.map((line, i) => {
    const event = parseStreamLine(line, RECORDED_START_MS);
    return { seq: firstSeq + i, ts: event.ts, type: event.type, payload: event.payload };
  });
}
