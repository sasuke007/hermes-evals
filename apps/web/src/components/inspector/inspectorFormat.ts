/**
 * How the run inspector words and draws what GET /runs/:id sends (RunInspector,
 * RunInspectorStates, Components 2 › EventTimeline): event times and durations, the
 * timeline's count line and legend sentence, how each row and scrubber tick is drawn, image
 * digests, artifact origins, the parsed-answer tree, and inline `code` in the
 * sentences the API and the boards write. Pure functions, so the components stay small and
 * the rules are tested once.
 */
import { TIMELINE_OUTPUT_LIMITS, timelineOutputLimit, type JsonValue } from '@hermes-evals/shared';
import type {
  ArtifactView,
  AttemptView,
  RunDetail,
  ScoreEvidenceView,
  TimelineEvent,
  TokenCounts,
} from '@/api/types/runs';
import { formatCount, formatDuration, formatUsd, plural } from '@/lib/format';
import { isMcpStreamNotOffered } from './neutralRows';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** A piece of a sentence: plain text, or a value set in mono. */
export interface RichPart {
  text: string;
  code: boolean;
}

/**
 * Splits "no `read_file` call" into text and code parts at backticks, as the boards write
 * keys, tools and paths; a fence marker such as ```json is code as written. A sentence
 * without backticks is one plain part; an unpaired backtick stays as written.
 */
export function richText(sentence: string | null | undefined): RichPart[] {
  if (!sentence) return [];
  const parts: RichPart[] = [];
  const re = /```[a-z]*|`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(sentence); m !== null; m = re.exec(sentence)) {
    if (m.index > at) parts.push({ text: sentence.slice(at, m.index), code: false });
    parts.push({ text: m[1] ?? m[0], code: true });
    at = m.index + m[0].length;
  }
  if (at < sentence.length) parts.push({ text: sentence.slice(at), code: false });
  return parts;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Milliseconds since the attempt started, as the timeline reads it: +00:04.2. */
export function formatAt(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `+${pad(minutes)}:${pad(seconds)}.${tenths % 10}`;
}

/** An event's duration: 0.4 s, 30.6 s, then 4m 12s from a minute on. */
export function formatEventDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(ms / 1000);
}

/** Elapsed time of a live run: 00:38, 4:05:12 past an hour. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const clock = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h > 0 ? `${h}:${clock}` : clock;
}

/** 11,400 in · 1,900 out. */
export function formatTokensInOut(tokens: Pick<TokenCounts, 'input' | 'output'>): string {
  return `${formatCount(tokens.input)} in · ${formatCount(tokens.output)} out`;
}

/** One run's estimated cost, as the Runs and inspector boards write it: $0.011 (else $0.98 rules). */
export function formatRunCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '–';
  if (usd > 0 && usd < 0.001) return formatUsd(usd);
  return usd < 1 ? `$${usd.toFixed(3)}` : formatUsd(usd);
}

/** An image digest as the launch record shows it: sha256:7a6920…. */
export function shortDigest(digest: string): string {
  const hex = digest.replace(/^sha256:/, '');
  return hex.length > 6 ? `sha256:${hex.slice(0, 6)}…` : `sha256:${hex}`;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * How a row and its scrubber tick are drawn: a tool call, an MCP server's tool (accent),
 * an error (fail; a refusal the agent's own call caused is one), a model call or other
 * network row (hollow, neutral), Hermes's own refused background request (hatched,
 * neutral), agent text, the final response, a platform event, a call still running.
 */
export type EventLook =
  'tool' | 'mcp' | 'error' | 'net' | 'refused' | 'text' | 'final' | 'platform' | 'running';

export function eventLook(event: TimelineEvent): EventLook {
  if (event.running) return 'running';
  if (event.origin === 'hermes-background') return event.kind === 'refused' ? 'refused' : 'net';
  if (isMcpStreamNotOffered(event)) return 'net';
  if (event.error) return 'error';
  if (event.kind === 'tool') return event.server ? 'mcp' : 'tool';
  if (event.kind === 'network') return 'net';
  if (event.kind === 'refused') return 'error';
  if (event.kind === 'final') return 'final';
  if (event.kind === 'platform') return 'platform';
  return 'text';
}

/** The platform row a cancel ends the timeline with, drawn as a dashed marker. */
export function isCancelMarker(event: TimelineEvent): boolean {
  return event.kind === 'platform' && event.title === 'cancelled';
}

const isModelCall = (e: TimelineEvent): boolean =>
  e.kind === 'network' && (e.network?.kind ?? 'model') === 'model';

/** "9 events · 3 tool calls · 3 model calls · 1 refused connection · 1 error". */
export function timelineCounts(events: readonly TimelineEvent[]): string {
  const tools = events.filter((e) => e.kind === 'tool').length;
  const models = events.filter(isModelCall).length;
  const otherNetwork = events.filter((e) => e.kind === 'network' && !isModelCall(e)).length;
  const refused = events.filter((e) => e.kind === 'refused').length;
  const errors = events.filter((e) => eventLook(e) === 'error').length;
  return [
    plural(events.length, 'event'),
    plural(tools, 'tool call'),
    plural(models, 'model call'),
    otherNetwork ? plural(otherNetwork, 'other network call') : null,
    plural(refused, 'refused connection'),
    errors ? plural(errors, 'error') : 'no errors',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Model-call tokens summed over the timeline: what "Tokens so far" shows while running. */
export function modelCallTokens(events: readonly TimelineEvent[]): TokenCounts | null {
  const calls = events.filter((e) => isModelCall(e) && e.network?.tokensIn !== null);
  if (!calls.length) return null;
  const input = calls.reduce((sum, e) => sum + (e.network?.tokensIn ?? 0), 0);
  const output = calls.reduce((sum, e) => sum + (e.network?.tokensOut ?? 0), 0);
  return { input, output, total: input + output };
}

const seconds1 = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/**
 * The sentence under the legend of a finished run: "Model calls account for 46.8 s and
 * tool calls for 2.7 s of the run's 52 s. Model-call tokens add up to the header: 11,400 in
 * · 1,900 out." Null while the run has no duration.
 */
export function timelineLegend(detail: RunDetail): string | null {
  const events = detail.timeline.events;
  if (detail.durationS === null || !events.length) return null;
  const sum = (list: TimelineEvent[]) => list.reduce((a, e) => a + (e.durationMs ?? 0), 0);
  const parts = [
    `Model calls account for ${seconds1(sum(events.filter(isModelCall)))} and tool calls for ${seconds1(
      sum(events.filter((e) => e.kind === 'tool')),
    )} of the run's ${formatDuration(detail.durationS)}.`,
  ];
  const tokens = modelCallTokens(events);
  if (tokens && detail.tokens) {
    parts.push(
      tokens.input === detail.tokens.input && tokens.output === detail.tokens.output
        ? `Model-call tokens add up to the header: ${formatTokensInOut(tokens)}.`
        : `Model calls in this timeline report ${formatTokensInOut(tokens)}; the header counts ${formatTokensInOut(detail.tokens)}.`,
    );
  }
  if (events.some((e) => e.server)) {
    parts.push('MCP tool calls carry the server name and an accent tick.');
  }
  return parts.join(' ');
}

/** The row opened by default: the first error, else the first tool call. */
export function defaultOpenSeq(events: readonly TimelineEvent[]): number | null {
  const error = events.find((e) => e.kind === 'tool' && e.error);
  return (error ?? events.find((e) => e.kind === 'tool'))?.seq ?? null;
}

/** "742 characters · not truncated. Output beyond 5,000 characters is truncated …". */
export function outputNote(event: TimelineEvent): string {
  if (event.outputChars === null) return '';
  const size = plural(event.outputChars, 'character');
  // An MCP tool's result keeps 20,000 characters, any other tool's 5,000 (Phase 6 question 13).
  const kept = timelineOutputLimit(event);
  const limit = formatCount(kept);
  // Hermes's stream-json emitter cuts every tool output at 5,000 characters and "..." before
  // the worker reads it, so an MCP result marked cut inside the 20,000 window arrived cut.
  if (event.truncated && event.outputChars <= kept && kept > TIMELINE_OUTPUT_LIMITS.tool) {
    return `${size} · Truncated by Hermes at ${formatCount(TIMELINE_OUTPUT_LIMITS.tool)} characters before the run's events were recorded.`;
  }
  return event.truncated
    ? `${size} · Truncated by the runtime at ${limit} characters.`
    : `${size} · not truncated. Output beyond ${limit} characters is truncated by the runtime and marked here.`;
}

/** The detail line of a network row when the API sent no text of its own. */
export function networkLine(event: TimelineEvent): string {
  const n = event.network;
  if (!n) return event.text ?? '';
  if (isMcpStreamNotOffered(event)) {
    return `${n.server ?? 'The MCP server'} offers no event stream: it answered the MCP client's GET with 405, as the protocol allows. Its tools are called over POST, so the run is not affected.`;
  }
  if (n.decision === 'denied') {
    const target = n.host ? `${n.host}${n.port ? `:${n.port}` : ''}` : (n.url ?? '');
    return `Refused by sandbox: ${target}${n.reason ? ` (${n.reason})` : ''}.`;
  }
  const call = [n.method, n.url ?? (n.host ? `${n.host}:${n.port ?? ''}` : null)]
    .filter(Boolean)
    .join(' ');
  const status = n.status !== null ? ` → ${n.status}` : '';
  const forwarded = n.forwardedTo ? `, forwarded to ${n.forwardedTo}` : '';
  return `${call}${status}${forwarded}.`;
}

// ---------------------------------------------------------------------------
// Attempts, artifacts, answers
// ---------------------------------------------------------------------------

/** The attempts table's "Ended by" column. */
export function endedBy(attempt: AttemptView): string {
  if (attempt.status === 'running') return 'still running';
  if (attempt.status === 'scored' || attempt.status === 'executed') return 'finished';
  if (attempt.status === 'cancelled') return 'cancelled';
  switch (attempt.category) {
    case 'timeout':
      return 'platform time limit';
    case 'limit':
      return 'token cap';
    case 'provider':
      return 'provider error';
    case 'setup':
      return 'setup failure';
    case 'worker_lost':
      return 'worker lost';
    default:
      return 'stopped';
  }
}

export const ORIGIN_LABELS: Record<ArtifactView['origin'], string> = {
  fixture_unchanged: 'fixture · unchanged',
  fixture_modified: 'fixture · modified',
  document_unchanged: 'document · unchanged',
  document_modified: 'document · modified',
  home_seed_unchanged: 'home seed · unchanged',
  home_seed_modified: 'home seed · modified',
  agent: 'written by agent',
};

const TABLE_EXTENSIONS = new Set(['csv', 'tsv']);
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'log',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'py',
  'sh',
  'js',
  'ts',
  'sql',
  'toml',
  'ini',
  'cfg',
  'conf',
]);

const extensionOf = (path: string): string => path.split('/').pop()?.split('.').pop() ?? '';

/** How an artifact can be previewed inline: as a table, as plain text, or not at all. */
export function previewKind(artifact: ArtifactView): 'table' | 'text' | null {
  if (artifact.sha256 === null && artifact.preview === null) return null;
  const ext = extensionOf(artifact.path).toLowerCase();
  if (TABLE_EXTENSIONS.has(ext)) return 'table';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
}

/** invoices.csv from workspace/invoices.csv. */
export const fileName = (path: string): string => path.split('/').pop() ?? path;

/**
 * Whether the run had memory on: config.yaml's `memory.memory_enabled`, as the launch record
 * keeps the file verbatim (the API writes it with the yaml package, one key per line). Null
 * without a launch record: nothing was launched, so nothing says.
 */
export function memoryEnabledIn(record: { configYaml: string } | null): boolean | null {
  if (!record) return null;
  return /^\s+memory_enabled:\s*true\s*$/m.test(record.configYaml);
}

/** One line of the parsed-answer and reference trees. */
export interface AnswerLine {
  key: string | null;
  summary: string;
  items: string[];
}

/** JSON on one line with the spacing people write: ["INV-1042", "INV-1107"]. */
export function inlineJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value);
}

function summaryOf(value: JsonValue): { summary: string; items: string[] } {
  if (Array.isArray(value)) {
    return { summary: `array(${value.length})`, items: value.map(inlineJson) };
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    return {
      summary: `object(${entries.length})`,
      items: entries.map(([k, v]) => `${k}: ${inlineJson(v)}`),
    };
  }
  return { summary: inlineJson(value), items: [] };
}

/**
 * The parsed answer or reference as the Final response pane lists it: one line per
 * top-level key with a summary (array(2), object(5), or the value), and its elements under it.
 */
export function answerTree(value: JsonValue): AnswerLine[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([key, v]) => ({ key, ...summaryOf(v) }));
  }
  return [{ key: null, ...summaryOf(value) }];
}

/** Ranges of every fenced ```json block of a text, fences included. */
export function jsonFences(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /```json[^\n]*\n[\s\S]*?```/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Line and column (both from 1) of a character offset. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

// ---------------------------------------------------------------------------
// Score evidence
// ---------------------------------------------------------------------------

/**
 * The label of a score's evidence expander: "4 of 5 keys match", "Found 1 of 2",
 * "read_file called 3 times", "judge openai/gpt-6.1-sol · 2,052 tokens · $0.0018". Null when
 * the scorer recorded nothing to show.
 */
export function evidenceSummary(evidence: ScoreEvidenceView): string | null {
  const parts: string[] = [];
  const json = evidence.jsonMatch;
  if (json) {
    parts.push(
      json.unit === 'value'
        ? json.matched === json.total
          ? 'the value matches'
          : 'the value does not match'
        : `${formatCount(json.matched)} of ${formatCount(json.total)} ${json.unit} match`,
    );
  }
  const text = evidence.text;
  if (text) {
    parts.push(`Found ${text.items.filter((i) => i.found).length} of ${text.items.length}`);
  }
  const trajectory = evidence.trajectory;
  if (trajectory) {
    parts.push(
      trajectory.mode
        ? `${plural(trajectory.calls, 'tool call')} compared (${trajectory.mode})`
        : `${trajectory.tool} called ${formatCount(trajectory.calls)} ${trajectory.calls === 1 ? 'time' : 'times'}`,
    );
  }
  const judge = evidence.judge;
  if (judge) {
    parts.push(
      [
        `judge ${judge.model}`,
        `${formatCount(judge.tokens.total)} tokens`,
        judge.costUsd !== null ? formatUsd(judge.costUsd) : null,
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }
  if (!parts.length && evidence.eventSeqs.length) {
    parts.push(plural(evidence.eventSeqs.length, 'timeline event'));
  }
  return parts.length ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------------------
// Row icons and scrubber ticks (Tailwind classes written out in full)
// ---------------------------------------------------------------------------

/** The 14px mark of a timeline row, per look (RunInspector › .evrow). */
export const EVENT_ICON: Record<EventLook, string> = {
  tool: 'size-14 rounded-3 inset-ring-[1.5px] inset-ring-text-3',
  mcp: 'size-14 rounded-3 inset-ring-[1.5px] inset-ring-accent',
  error: 'size-14 rounded-3 bg-fail',
  net: 'size-14 rounded-full inset-ring-[1.5px] inset-ring-text-3',
  refused:
    'size-14 rounded-full inset-ring-[1.5px] inset-ring-text-3 bg-[linear-gradient(135deg,transparent_45%,var(--text-3)_45%_55%,transparent_55%)]',
  text: 'size-14 rounded-3 bg-surface-3',
  final: 'size-14 rounded-3 bg-text',
  platform: 'size-14 rounded-3 bg-surface-3',
  running: 'size-12 animate-spin rounded-full border-2 border-run border-r-transparent',
};

/** A scrubber tick, per look: tools tall, MCP accent, text short, errors tall and orange. */
export const EVENT_TICK: Record<EventLook, string> = {
  tool: 'h-18 bg-text-3',
  mcp: 'h-18 bg-accent',
  error: 'h-24 bg-fail',
  net: 'h-12 bg-transparent inset-ring-[1.5px] inset-ring-text-2',
  refused:
    'h-12 bg-[repeating-linear-gradient(135deg,var(--text-3)_0_1.5px,transparent_1.5px_3.5px)]',
  text: 'h-8 bg-border-strong',
  final: 'h-24 bg-text',
  platform: 'h-8 bg-border-strong',
  running: 'h-20 animate-live bg-run',
};

/** Which look a scrubber bucket of several events takes: the one that matters most. */
export const LOOK_PRIORITY: EventLook[] = [
  'error',
  'running',
  'final',
  'mcp',
  'tool',
  'refused',
  'net',
  'platform',
  'text',
];
