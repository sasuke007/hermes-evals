/**
 * The one status tone table. Every chip, dot and cell colour for a status value comes from
 * here, following the status mapping on the visual direction board (Main) and the chip groups
 * on Components 1 and Components 3.
 *
 * Tones: pass (green) usable or passed · fail (orange) failed or broken · err (violet) a check
 * or execution broke · ung (amber) the user must act · run (blue) working · que (neutral)
 * nothing wrong yet, or no claim made.
 * Dots: solid · hollow (a ring: not started, not a claim) · pulse (live) · none. A pause
 * because a provider disconnected is two chips: the neutral experiment `paused`, and the
 * amber `pauseReason` chip beside it (Components 3).
 * TONE_CLASSES turns a tone into Tailwind utilities; the class names are written out in full
 * so Tailwind finds them.
 */

export type Tone = 'pass' | 'fail' | 'err' | 'ung' | 'run' | 'que';
export type DotMode = 'solid' | 'hollow' | 'pulse' | 'none';
export type StatusKind =
  | 'run'
  | 'score'
  | 'experiment'
  | 'verdict'
  | 'provider'
  | 'pauseReason'
  | 'category'
  | 'evaluation'
  | 'mcpTest'
  | 'secret'
  | 'sandbox'
  | 'worker';

export interface StatusTone {
  tone: Tone;
  dot: DotMode;
  /** The word shown on screen. For data-model statuses it is the stored value itself. */
  label: string;
  /** Verdicts are drawn heavier, with a 1px ring in the tone colour. */
  strong?: boolean;
  /**
   * Verdict states that are not a verdict (VerdictCard states): `dashed` a provisional figure
   * (surface-2 fill, dashed border), `muted` none at all (surface-2 fill, --text-3).
   */
  appearance?: 'dashed' | 'muted';
}

const t = (
  tone: Tone,
  dot: DotMode,
  label: string,
  extra: Pick<StatusTone, 'strong' | 'appearance'> = {},
): StatusTone => ({ tone, dot, label, ...extra });
const strong = { strong: true } as const;

/** Keyed by the raw value the API returns. */
export const STATUS_TONES: Record<StatusKind, Record<string, StatusTone>> = {
  score: {
    passed: t('pass', 'solid', 'passed'),
    failed: t('fail', 'solid', 'failed'),
    error: t('err', 'solid', 'error'),
    ungradable: t('ung', 'solid', 'ungradable'),
  },
  run: {
    queued: t('que', 'hollow', 'queued'),
    running: t('run', 'pulse', 'running'),
    executed: t('run', 'hollow', 'executed'),
    scoring: t('run', 'pulse', 'scoring'),
    scored: t('que', 'solid', 'scored'),
    execution_error: t('err', 'solid', 'execution_error'),
    cancelled: t('que', 'hollow', 'cancelled'),
  },
  experiment: {
    running: t('run', 'pulse', 'running'),
    paused: t('que', 'hollow', 'paused'),
    completed: t('que', 'solid', 'completed'),
    failed: t('err', 'solid', 'failed'),
  },
  /** VERDICT_STATES: the three verdicts, and the two states that are not one yet. */
  verdict: {
    better: t('pass', 'solid', 'better', strong),
    worse: t('fail', 'solid', 'worse', strong),
    inconclusive: t('que', 'hollow', 'inconclusive', strong),
    provisional: t('que', 'none', 'provisional', { strong: true, appearance: 'dashed' }),
    not_computable: t('que', 'none', 'not computable', { strong: true, appearance: 'muted' }),
  },
  /** Nous Portal login states and API-key presence (Components 3, ModelAccessStates). */
  provider: {
    not_connected: t('que', 'hollow', 'not connected'),
    waiting_for_approval: t('run', 'pulse', 'waiting'),
    connected: t('pass', 'solid', 'connected'),
    relogin_required: t('ung', 'solid', 'reconnect'),
    expired: t('que', 'hollow', 'expired'),
    denied: t('que', 'hollow', 'declined'),
    needs_subscription: t('ung', 'solid', 'subscription'),
    failed: t('fail', 'solid', 'error'),
    host: t('run', 'solid', 'this machine'),
    host_unreachable: t('ung', 'hollow', 'not running'),
    /** nous-login's startup check failed (UI_FLOWS 19 #12; Components 1 draws it in fail). */
    unavailable: t('fail', 'solid', 'unavailable'),
    configured: t('pass', 'solid', 'configured'),
    missing: t('que', 'hollow', 'missing'),
  },
  /** Why an experiment is paused (Components 3). */
  pauseReason: {
    provider_disconnected: t('ung', 'solid', 'provider disconnected'),
    spend_ceiling: t('que', 'none', 'spend ceiling'),
    user: t('que', 'none', 'by user'),
  },
  /**
   * Why an attempt ended in execution_error (EXECUTION_ERROR_CATEGORIES). `limit`: the model
   * gateway's per-attempt token cap stopped the run; never retried automatically.
   */
  category: {
    provider: t('err', 'solid', 'provider'),
    timeout: t('err', 'solid', 'timeout'),
    setup: t('err', 'solid', 'setup'),
    worker_lost: t('err', 'solid', 'worker_lost'),
    limit: t('err', 'solid', 'limit'),
    other: t('err', 'solid', 'other'),
  },
  /** One scoring pass (EVALUATION_STATUSES): a pending re-score is queued or running. */
  evaluation: {
    queued: t('que', 'hollow', 'queued'),
    running: t('run', 'pulse', 'running'),
    completed: t('que', 'solid', 'completed'),
    failed: t('fail', 'solid', 'failed'),
  },
  /** An MCP server's last "Test start" (McpTestView.status). */
  mcpTest: {
    untested: t('que', 'hollow', 'untested'),
    running: t('run', 'pulse', 'running'),
    passed: t('pass', 'solid', 'passed'),
    failed: t('fail', 'solid', 'failed'),
  },
  /** Whether a secret name has a value where it is read (Resources › Secrets). */
  secret: {
    set: t('pass', 'solid', 'set'),
    not_set: t('ung', 'hollow', 'not set'),
  },
  /** Sandbox isolation result and worker presence (System). */
  sandbox: {
    proven: t('pass', 'solid', 'proven'),
    not_proven: t('fail', 'solid', 'not proven'),
  },
  worker: {
    online: t('pass', 'solid', 'online'),
    offline: t('fail', 'solid', 'offline'),
  },
};

/** Display words the design also uses as values, mapped to the raw value. */
const ALIASES: Partial<Record<StatusKind, Record<string, string>>> = {
  provider: {
    waiting: 'waiting_for_approval',
    reconnect: 'relogin_required',
    needs_renewing: 'relogin_required',
    declined: 'denied',
    subscription: 'needs_subscription',
    error: 'failed',
    this_machine: 'host',
    not_running: 'host_unreachable',
  },
  pauseReason: { by_user: 'user' },
};

function normalise(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export interface StatusToneOptions {
  /** false draws pulsing dots solid (a value that is not updating live). Default true. */
  live?: boolean;
}

/** The tone, dot and label for a status value. Unknown values fall back to a neutral chip. */
export function statusTone(
  kind: StatusKind,
  status: string,
  options: StatusToneOptions = {},
): StatusTone {
  const table = STATUS_TONES[kind];
  const key = normalise(status);
  const found = table[key] ?? table[ALIASES[kind]?.[key] ?? ''];
  let result: StatusTone = found ?? { tone: 'que', dot: 'solid', label: status };
  if (options.live === false && result.dot === 'pulse') result = { ...result, dot: 'solid' };
  return result;
}

/** Tailwind utilities for one tone. */
export interface ToneClasses {
  /** Solid fill: dots, cells, bars. */
  solid: string;
  /** Soft fill: chips, banners, selected rows. */
  soft: string;
  /** Text on the soft fill. */
  text: string;
  /** Text in the solid colour: icons. */
  fg: string;
  /** A border in the solid colour: hollow dots, banners. */
  border: string;
  /** A 1px inset ring in the solid colour: strong chips, marks. */
  ring: string;
  /** soft + text: a chip in this tone. */
  chip: string;
}

export const TONE_CLASSES: Record<Tone, ToneClasses> = {
  pass: {
    solid: 'bg-pass',
    soft: 'bg-pass-soft',
    text: 'text-pass-text',
    fg: 'text-pass',
    border: 'border-pass',
    ring: 'inset-ring inset-ring-pass',
    chip: 'bg-pass-soft text-pass-text',
  },
  fail: {
    solid: 'bg-fail',
    soft: 'bg-fail-soft',
    text: 'text-fail-text',
    fg: 'text-fail',
    border: 'border-fail',
    ring: 'inset-ring inset-ring-fail',
    chip: 'bg-fail-soft text-fail-text',
  },
  err: {
    solid: 'bg-err',
    soft: 'bg-err-soft',
    text: 'text-err-text',
    fg: 'text-err',
    border: 'border-err',
    ring: 'inset-ring inset-ring-err',
    chip: 'bg-err-soft text-err-text',
  },
  ung: {
    solid: 'bg-ung',
    soft: 'bg-ung-soft',
    text: 'text-ung-text',
    fg: 'text-ung',
    border: 'border-ung',
    ring: 'inset-ring inset-ring-ung',
    chip: 'bg-ung-soft text-ung-text',
  },
  run: {
    solid: 'bg-run',
    soft: 'bg-run-soft',
    text: 'text-run-text',
    fg: 'text-run',
    border: 'border-run',
    ring: 'inset-ring inset-ring-run',
    chip: 'bg-run-soft text-run-text',
  },
  que: {
    solid: 'bg-que',
    soft: 'bg-que-soft',
    text: 'text-que-text',
    fg: 'text-que',
    border: 'border-que',
    ring: 'inset-ring inset-ring-que',
    chip: 'bg-que-soft text-que-text',
  },
};

/** CSS custom property names for a tone: { solid: 'var(--pass)', soft: …, text: … }. */
export function toneVars(tone: Tone): { solid: string; soft: string; text: string } {
  return { solid: `var(--${tone})`, soft: `var(--${tone}-soft)`, text: `var(--${tone}-text)` };
}
