/**
 * Passing "Test start" results of unsaved forms (Phase 5 question 14). POST
 * /resources/mcp-servers/test stores nothing in the database, so the row a
 * save creates right after a passing test used to read "untested" until the
 * saved server was tested again. The API now keeps each passing result by
 * the hash of the definition it ran on (definitionHash, which covers the
 * name), and a save whose definition hashes the same records it as the
 * version's last test.
 *
 * In memory: there is one API process, and a result that is lost on a
 * restart costs one more Test start. Results expire after a day, as the
 * test jobs themselves do, and at most MAX_KEPT are kept.
 */
import { Injectable } from '@nestjs/common';
import type { McpTestView } from '@hermes-evals/shared';
import type { McpTestRecord } from './test-record.js';

type PassedView = Extract<McpTestView, { status: 'passed' }>;
export type PassedTestRecord = Extract<McpTestRecord, { status: 'passed' }>;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEPT = 200;

/** The record a worker would have written for this passing view. */
export function passedRecordOf(view: PassedView, jobId: string): PassedTestRecord {
  return {
    status: 'passed',
    job_id: jobId,
    requested_at: view.requestedAt,
    finished_at: view.finishedAt,
    started_ms: view.startedMs,
    tools: view.tools.map((tool) =>
      tool.description === null
        ? { name: tool.name }
        : { name: tool.name, description: tool.description },
    ),
  };
}

@Injectable()
export class UnsavedMcpTests {
  private readonly passed = new Map<string, { record: PassedTestRecord; keptAt: number }>();

  /** The clock; tests replace it. */
  now: () => number = Date.now;

  /** Keeps a passing result of the definition with this hash; the newest wins. */
  remember(definitionHash: string, record: PassedTestRecord): void {
    this.passed.delete(definitionHash);
    this.passed.set(definitionHash, { record, keptAt: this.now() });
    // A Map iterates in insertion order, so the first key is the oldest.
    while (this.passed.size > MAX_KEPT) {
      const oldest = this.passed.keys().next().value;
      if (oldest === undefined) break;
      this.passed.delete(oldest);
    }
  }

  /** The passing result kept for this definition hash, or null. */
  passedFor(definitionHash: string): PassedTestRecord | null {
    const kept = this.passed.get(definitionHash);
    if (!kept) return null;
    if (this.now() - kept.keptAt > DAY_MS) {
      this.passed.delete(definitionHash);
      return null;
    }
    return kept.record;
  }
}
