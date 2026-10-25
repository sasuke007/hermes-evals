import { describe, expect, it } from 'vitest';
import { SAMPLE_RUN_ID } from '@/fixtures/experiments';
import type { ArtifactView, ScoreEvidenceView, TimelineEvent } from '@/api/types/runs';
import {
  answerTree,
  defaultOpenSeq,
  endedBy,
  evidenceSummary,
  eventLook,
  formatAt,
  formatElapsed,
  formatEventDuration,
  formatRunCost,
  jsonFences,
  lineColumn,
  networkLine,
  outputNote,
  previewKind,
  richText,
  shortDigest,
  timelineCounts,
  timelineLegend,
} from '../inspectorFormat';
import { detailOf } from './inspectorEnv';

const sample = () => detailOf(SAMPLE_RUN_ID);

describe('text', () => {
  it('splits keys in backticks and fence markers into code parts', () => {
    expect(richText('no `read_file` call on invoices.csv')).toEqual([
      { text: 'no ', code: false },
      { text: 'read_file', code: true },
      { text: ' call on invoices.csv', code: false },
    ]);
    expect(richText('and no ```json block.')).toEqual([
      { text: 'and no ', code: false },
      { text: '```json', code: true },
      { text: ' block.', code: false },
    ]);
    expect(richText('plain')).toEqual([{ text: 'plain', code: false }]);
    expect(richText('one ` tick')).toEqual([{ text: 'one ` tick', code: false }]);
    expect(richText(null)).toEqual([]);
  });

  it('writes times, durations, digests and costs as the boards do', () => {
    expect(formatAt(600)).toBe('+00:00.6');
    expect(formatAt(51_600)).toBe('+00:51.6');
    expect(formatAt(300_000)).toBe('+05:00.0');
    expect(formatEventDuration(2_900)).toBe('2.9 s');
    expect(formatEventDuration(null)).toBe('');
    expect(formatEventDuration(212_000)).toBe('3m 32s');
    expect(formatElapsed(38)).toBe('00:38');
    expect(formatElapsed(3_725)).toBe('1:02:05');
    expect(shortDigest('sha256:7a69201234567890')).toBe('sha256:7a6920…');
    expect(formatRunCost(0.011)).toBe('$0.011');
    expect(formatRunCost(1.5)).toBe('$1.50');
    expect(formatRunCost(null)).toBe('–');
  });

  it('finds the fenced json blocks and a line and column', () => {
    const text = 'a\n```json\n{"x": 1}\n```\nb\n```json\n{"x": 2}\n```';
    const fences = jsonFences(text);
    expect(fences).toHaveLength(2);
    expect(text.slice(fences[1]!.start, fences[1]!.end)).toBe('```json\n{"x": 2}\n```');
    expect(lineColumn('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });

  it('lists a parsed answer by key', () => {
    expect(answerTree({ duplicates: [['A', 'B']], total: 3 })).toEqual([
      { key: 'duplicates', summary: 'array(1)', items: ['["A", "B"]'] },
      { key: 'total', summary: '3', items: [] },
    ]);
    expect(answerTree({ vendors: { Kestrel: 9.5 } })[0]).toEqual({
      key: 'vendors',
      summary: 'object(1)',
      items: ['Kestrel: 9.5'],
    });
    expect(answerTree([1, 2])).toEqual([{ key: null, summary: 'array(2)', items: ['1', '2'] }]);
  });
});

describe('timeline', () => {
  it("counts the board run's events", () => {
    expect(timelineCounts(sample().timeline.events)).toBe(
      '9 events · 3 tool calls · 3 model calls · 1 refused connection · 1 error',
    );
    expect(timelineCounts([])).toBe(
      '0 events · 0 tool calls · 0 model calls · 0 refused connections · no errors',
    );
  });

  it('writes the legend sentence of a finished run', () => {
    expect(timelineLegend(sample())).toBe(
      "Model calls account for 46.8 s and tool calls for 2.7 s of the run's 52 s. Model-call tokens add up to the header: 11,400 in · 1,900 out.",
    );
    const running = { ...sample(), durationS: null };
    expect(timelineLegend(running)).toBeNull();
  });

  it('draws each kind of row its own way', () => {
    const events = sample().timeline.events;
    expect(events.map(eventLook)).toEqual([
      'refused',
      'net',
      'tool',
      'error',
      'net',
      'tool',
      'net',
      'text',
      'final',
    ]);
    const base = events[2]!;
    expect(eventLook({ ...base, server: 'invoice-db' })).toBe('mcp');
    expect(eventLook({ ...base, running: true })).toBe('running');
    const refusal = { ...events[0]!, origin: 'agent' as const, error: true };
    expect(eventLook(refusal)).toBe('error');
  });

  it('opens the first error, else the first tool call', () => {
    const events = sample().timeline.events;
    expect(defaultOpenSeq(events)).toBe(4);
    expect(defaultOpenSeq(events.filter((e) => !e.error))).toBe(3);
    expect(defaultOpenSeq([])).toBeNull();
  });

  it('notes the output size and the runtime truncation', () => {
    const tool = sample().timeline.events[2]!;
    expect(outputNote(tool)).toBe(
      '742 characters · not truncated. Output beyond 5,000 characters is truncated by the runtime and marked here.',
    );
    expect(outputNote({ ...tool, outputChars: 5000, truncated: true })).toBe(
      '5,000 characters · Truncated by the runtime at 5,000 characters.',
    );
  });

  it('builds a network line when the API sent no text', () => {
    const net = sample().timeline.events[1]! as TimelineEvent;
    expect(networkLine({ ...net, text: null })).toBe(
      'POST http://egress:8080/v1/chat/completions → 200, forwarded to Nous Portal.',
    );
    const refused = sample().timeline.events[0]!;
    expect(networkLine({ ...refused, text: null })).toBe(
      'Refused by sandbox: inference-api.nousresearch.com:443 (not on the allowlist).',
    );
  });
});

describe('attempts, artifacts, evidence', () => {
  it('says what ended an attempt', () => {
    const attempt = sample().attempts[0]!;
    expect(endedBy(attempt)).toBe('finished');
    expect(endedBy({ ...attempt, status: 'execution_error', category: 'timeout' })).toBe(
      'platform time limit',
    );
    expect(endedBy({ ...attempt, status: 'execution_error', category: 'limit' })).toBe('token cap');
    expect(endedBy({ ...attempt, status: 'cancelled', category: null })).toBe('cancelled');
  });

  it('previews CSV and TSV as tables and text files as text', () => {
    const art: ArtifactView = {
      id: 'a',
      path: 'workspace/summary.csv',
      origin: 'agent',
      sizeBytes: 10,
      sha256: 'f'.repeat(64),
      skippedReason: null,
      preview: null,
    };
    expect(previewKind(art)).toBe('table');
    expect(previewKind({ ...art, path: 'workspace/out.TSV' })).toBe('table');
    expect(previewKind({ ...art, path: 'workspace/notes.txt' })).toBe('text');
    expect(previewKind({ ...art, path: 'workspace/report.pdf' })).toBeNull();
    expect(previewKind({ ...art, sha256: null, skippedReason: 'too_large' })).toBeNull();
  });

  it('labels the evidence expander', () => {
    const empty: ScoreEvidenceView = {
      eventSeqs: [],
      artifactIds: [],
      judge: null,
      trajectory: null,
      text: null,
      jsonMatch: null,
    };
    expect(evidenceSummary(empty)).toBeNull();
    expect(
      evidenceSummary({
        ...empty,
        jsonMatch: { unit: 'keys', matched: 4, total: 5, mismatches: ['x.y'] },
      }),
    ).toBe('4 of 5 keys match');
    expect(
      evidenceSummary({
        ...empty,
        text: {
          items: [
            { kind: 'phrase', label: '1.5%', found: true },
            { kind: 'phrase', label: '30 days', found: false },
          ],
          truncated: false,
        },
      }),
    ).toBe('Found 1 of 2');
    expect(
      evidenceSummary({
        ...empty,
        trajectory: { tool: 'invoice-db.list_invoices', calls: 3, matchedSeqs: [4], mode: null },
      }),
    ).toBe('invoice-db.list_invoices called 3 times');
    expect(evidenceSummary({ ...empty, eventSeqs: [9] })).toBe('1 timeline event');
  });
});
