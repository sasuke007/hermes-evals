/**
 * The one status tone table. Every chip, dot and cell colour for a status value comes from
 * here, following the status mapping on the visual direction board (Main) and the chip groups
 * on Components 1 and Components 3.
 *
 * Tones: pass (green) usable or passed · fail (orange) failed or broken · err (violet) a check
 * or execution broke · ung (amber) the user must act · run (blue) working · que (neutral)
 * nothing wrong yet, or no claim made.
 * Dots: solid · hollow (a ring: not started, not a claim) · pulse (live) · square (paused
 * because the provider disconnected) · none.
 */

export type Tone = 'pass' | 'fail' | 'err' | 'ung' | 'run' | 'que';
export type DotMode = 'solid' | 'hollow' | 'pulse' | 'square' | 'none';
export type StatusKind =
  | 'run'
  | 'score'
  | 'experiment'
  | 'verdict'
  | 'provider'
  | 'pauseReason'
  | 'sandbox'
  | 'worker';

export interface StatusTone {
  tone: Tone;
  dot: DotMode;
  /** The word shown on screen. For data-model statuses it is the stored value itself. */
  label: string;
  /** Verdicts are drawn heavier, with a 1px ring in the tone colour. */
  strong?: boolean;
}

const t = (tone: Tone, dot: DotMode, label: string, strong?: boolean): StatusTone =>
  strong ? { tone, dot, label, strong } : { tone, dot, label };

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
  verdict: {
    better: t('pass', 'solid', 'better', true),
    worse: t('fail', 'solid', 'worse', true),
    inconclusive: t('que', 'hollow', 'inconclusive', true),
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
    configured: t('pass', 'solid', 'configured'),
    missing: t('que', 'hollow', 'missing'),
  },
  /** Why an experiment is paused (Components 3). */
  pauseReason: {
    provider_disconnected: t('ung', 'solid', 'provider disconnected'),
    spend_ceiling: t('que', 'none', 'spend ceiling'),
    user: t('que', 'none', 'by user'),
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
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export interface StatusToneOptions {
  /** false draws pulsing dots solid (a value that is not updating live). Default true. */
  live?: boolean;
  /** With kind 'experiment' and status 'paused': provider_disconnected turns the chip amber. */
  pauseReason?: string | null;
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
  if (
    kind === 'experiment' &&
    key === 'paused' &&
    options.pauseReason &&
    normalise(options.pauseReason) === 'provider_disconnected'
  ) {
    result = { tone: 'ung', dot: 'square', label: 'paused' };
  }
  if (options.live === false && result.dot === 'pulse') result = { ...result, dot: 'solid' };
  return result;
}

/** CSS custom property names for a tone: { solid: 'var(--pass)', soft: …, text: … }. */
export function toneVars(tone: Tone): { solid: string; soft: string; text: string } {
  return { solid: `var(--${tone})`, soft: `var(--${tone}-soft)`, text: `var(--${tone}-text)` };
}
