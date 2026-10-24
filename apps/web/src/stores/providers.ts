/**
 * Model access: provider statuses, the Nous Portal device-login state machine and the one
 * global ConnectDialog.
 *
 *   idle ──connect()──▶ requesting ──code issued──▶ waiting ──poll every 2 s──▶ connected
 *                            │                        │                        expired
 *                            └──────── cancel() ◀─────┘                        declined
 *                                                                              subscription
 *                                                                              failed
 *
 * Closing the dialog while waiting keeps the login going (polling continues and the AppShell
 * shows ApprovalPill with the countdown). Polling pauses while the document is hidden and
 * polls at once when it is visible again. Nothing launches or resumes by itself: on Connected,
 * the dialog's follow-up buttons call the callback the opener passed to connect().
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  cancelNousLogin,
  getNousLogin,
  listProviders,
  logoutNous,
  simulateNousLogin,
  startNousLogin,
  type LoginOutcome,
} from '@/api/providers';
import type { NousLogin, NousStatus, ProviderInfo } from '@/api/types/system';

/** Where ConnectDialog was opened from; chooses the follow-up offered on Connected. */
export type ConnectOrigin = 'new-experiment' | 'paused-experiment' | 'other';
/** What the user chose on Connected: Launch now, Back to the form, Resume experiment, Done. */
export type FollowUpAction = 'launch' | 'back' | 'resume' | 'done';
export type FollowUpHandler = (action: FollowUpAction) => void;
export type LoginPhase =
  | 'idle'
  | 'requesting'
  | 'waiting'
  | 'connected'
  | 'expired'
  | 'declined'
  | 'subscription'
  | 'failed';
/** The amber strip under the AppShell bar. */
export type BannerKind = 'none' | 'not-connected' | 'renewal';

/** Shown in the Connected step: "Skill vs no skill, invoices-v1 is still paused at 87 of 120." */
export interface ConnectContext {
  experimentName?: string | null;
  scored?: number | null;
  total?: number | null;
}

export const POLL_INTERVAL_MS = 2_000;
export const REFRESH_INTERVAL_MS = 30_000;

const PHASE_OF: Record<NousLogin['state'], LoginPhase> = {
  not_connected: 'idle',
  waiting_for_approval: 'waiting',
  connected: 'connected',
  expired: 'expired',
  denied: 'declined',
  needs_subscription: 'subscription',
  failed: 'failed',
};
const STATUS_OF_PHASE: Partial<Record<LoginPhase, NousStatus>> = {
  requesting: 'waiting_for_approval',
  waiting: 'waiting_for_approval',
  connected: 'connected',
  expired: 'expired',
  declined: 'denied',
  subscription: 'needs_subscription',
  failed: 'failed',
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** 892 → "14:52". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const useProvidersStore = defineStore('providers', () => {
  // ── provider list ──────────────────────────────────────────────────────
  const providers = ref<ProviderInfo[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // ── the Nous login ─────────────────────────────────────────────────────
  const loginPhase = ref<LoginPhase>('idle');
  const userCode = ref<string | null>(null);
  const verifyUrl = ref<string | null>(null);
  const expiresAt = ref<string | null>(null);
  const loginError = ref<string | null>(null);
  const billingUrl = ref<string | null>(null);
  /** The dialog reads "Reconnect Nous Portal" (renewal, or opened from a paused experiment). */
  const reconnecting = ref(false);

  // ── the dialog ─────────────────────────────────────────────────────────
  const dialogOpen = ref(false);
  const origin = ref<ConnectOrigin>('other');
  const context = ref<ConnectContext>({});
  let followUpHandler: FollowUpHandler | null = null;

  // ── clocks ─────────────────────────────────────────────────────────────
  const now = ref(Date.now());
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  /** Bumped by every start and cancel, so a late answer for an old login is ignored. */
  let attempt = 0;

  // ── derived ────────────────────────────────────────────────────────────
  const nous = computed(() => providers.value.find((p) => p.id === 'nous') ?? null);
  const keyProviders = computed(() => providers.value.filter((p) => p.authMethod === 'env-key'));

  /** Nous status with the live login applied (waiting while a code is out, then its outcome). */
  const nousStatus = computed<NousStatus>(
    () =>
      STATUS_OF_PHASE[loginPhase.value] ??
      (nous.value?.status as NousStatus | undefined) ??
      'not_connected',
  );
  const nousConnected = computed(
    () => nousStatus.value === 'connected' || nousStatus.value === 'host',
  );
  const anyConnected = computed(
    () => nousConnected.value || keyProviders.value.some((p) => p.status === 'configured'),
  );
  const nousInUse = computed(() => (nous.value?.usedBy.length ?? 0) > 0);
  /** Nous is not usable and something needs it (or nothing else is connected). */
  const nousBlocking = computed(
    () =>
      loaded.value &&
      nous.value !== null &&
      !nousConnected.value &&
      (nousInUse.value || !anyConnected.value),
  );
  /** The System dot turns amber: a provider in use cannot be reached. */
  const needsAttention = computed(
    () =>
      nousBlocking.value ||
      keyProviders.value.some((p) => p.status === 'missing' && p.usedBy.length > 0),
  );
  const bannerKind = computed<BannerKind>(() => {
    if (!loaded.value || nous.value === null) return 'none';
    if (nousStatus.value === 'relogin_required') return 'renewal';
    return nousBlocking.value ? 'not-connected' : 'none';
  });
  const pausedCount = computed(() => nous.value?.pausedExperiments ?? 0);

  const secondsLeft = computed(() => {
    if (!expiresAt.value) return 0;
    return Math.max(0, Math.ceil((Date.parse(expiresAt.value) - now.value) / 1000));
  });
  /** "14:52". */
  const countdown = computed(() => formatCountdown(secondsLeft.value));
  /** ApprovalPill text while a login waits and the dialog is closed; null hides the pill. */
  const approvalLeft = computed(() =>
    loginPhase.value === 'waiting' && !dialogOpen.value ? countdown.value : null,
  );
  const dialogHeading = computed(() =>
    reconnecting.value ? 'Reconnect Nous Portal' : 'Connect Nous Portal',
  );

  // ── polling ────────────────────────────────────────────────────────────
  function onVisibility(): void {
    if (isHidden() || loginPhase.value !== 'waiting') return;
    now.value = Date.now();
    void poll();
  }

  function startPolling(): void {
    if (pollTimer !== null) return;
    now.value = Date.now();
    pollTimer = setInterval(() => {
      if (!isHidden()) void poll();
    }, POLL_INTERVAL_MS);
    clockTimer = setInterval(() => {
      now.value = Date.now();
      // The code ran out: ask at once instead of waiting for the next poll.
      if (secondsLeft.value === 0 && !isHidden()) void poll();
    }, 1000);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
  }

  function stopPolling(): void {
    if (pollTimer !== null) clearInterval(pollTimer);
    if (clockTimer !== null) clearInterval(clockTimer);
    pollTimer = null;
    clockTimer = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  }

  async function poll(): Promise<void> {
    if (pollInFlight || loginPhase.value !== 'waiting') return;
    pollInFlight = true;
    const mine = attempt;
    try {
      const login = await getNousLogin();
      if (mine === attempt && loginPhase.value === 'waiting') applyLogin(login);
    } catch {
      /* keep waiting; the next poll tries again */
    } finally {
      pollInFlight = false;
    }
  }

  function clearCode(): void {
    userCode.value = null;
    verifyUrl.value = null;
    expiresAt.value = null;
  }

  function applyLogin(login: NousLogin): void {
    const phase = PHASE_OF[login.state];
    loginError.value = login.error;
    billingUrl.value = login.billingUrl ?? nous.value?.billingUrl ?? null;
    if (phase === 'waiting') {
      userCode.value = login.userCode;
      verifyUrl.value = login.verifyUrl;
      expiresAt.value = login.expiresAt;
      loginPhase.value = 'waiting';
      startPolling();
      return;
    }
    stopPolling();
    clearCode();
    // Show the outcome at once; load() below brings the server's view.
    const ended = STATUS_OF_PHASE[phase];
    if (ended && nous.value) nous.value.status = ended;
    // Ended while the dialog was closed: the provider row and the System dot show the outcome.
    loginPhase.value = dialogOpen.value ? phase : 'idle';
    if (!dialogOpen.value) followUpHandler = null;
    void load();
  }

  // ── actions ────────────────────────────────────────────────────────────

  /** GET /providers. Keeps the last good list on failure. */
  async function load(): Promise<void> {
    loading.value = true;
    try {
      const list = await listProviders();
      providers.value = list;
      loaded.value = true;
      error.value = null;
      // A login already waiting (another tab, or a reload): pick it up so the pill shows.
      const pending = list.find((p) => p.id === 'nous')?.login;
      if (loginPhase.value === 'idle' && pending?.state === 'waiting_for_approval') {
        applyLogin(pending);
      }
    } catch (err) {
      error.value = message(err);
    } finally {
      loading.value = false;
    }
  }

  async function requestCode(): Promise<void> {
    const mine = ++attempt;
    loginPhase.value = 'requesting';
    loginError.value = null;
    clearCode();
    try {
      const login = await startNousLogin();
      if (mine !== attempt || loginPhase.value !== 'requesting') return;
      applyLogin(login);
    } catch (err) {
      if (mine !== attempt) return;
      loginError.value = message(err);
      loginPhase.value = dialogOpen.value ? 'failed' : 'idle';
    }
  }

  /**
   * Open ConnectDialog and start a login (or reopen the one already waiting).
   * `onFollowUp` is called with the user's choice on Connected; nothing else happens by itself.
   */
  async function connect(
    from: ConnectOrigin = 'other',
    onFollowUp?: FollowUpHandler | null,
    ctx: ConnectContext = {},
  ): Promise<void> {
    origin.value = from;
    context.value = ctx;
    followUpHandler = onFollowUp ?? null;
    dialogOpen.value = true;
    if (loginPhase.value === 'waiting' || loginPhase.value === 'requesting') return;
    reconnecting.value = from === 'paused-experiment' || nous.value?.status === 'relogin_required';
    if (nousConnected.value) {
      // Already connected (a stale page): offer the follow-up straight away.
      loginPhase.value = 'connected';
      return;
    }
    await requestCode();
  }

  /** Get a new code / Try again: a fresh login with the same origin and follow-up. */
  async function retry(): Promise<void> {
    dialogOpen.value = true;
    await requestCode();
  }

  /** Cancel login: ends the pending login and closes the dialog. */
  async function cancel(): Promise<void> {
    attempt++;
    stopPolling();
    clearCode();
    loginPhase.value = 'idle';
    dialogOpen.value = false;
    followUpHandler = null;
    try {
      await cancelNousLogin();
    } catch (err) {
      error.value = message(err);
    }
    await load();
  }

  /** Reopen the dialog (ApprovalPill, "Open dialog"); starts a login when none is running. */
  async function openDialog(): Promise<void> {
    if (loginPhase.value === 'idle') {
      await connect('other');
      return;
    }
    dialogOpen.value = true;
  }

  /** Close (×, Esc, scrim, Close). A waiting login keeps going; an ended one is cleared. */
  function closeDialog(): void {
    dialogOpen.value = false;
    if (loginPhase.value !== 'waiting' && loginPhase.value !== 'requesting') {
      loginPhase.value = 'idle';
      followUpHandler = null;
    }
  }

  /** A follow-up button on Connected: close, then hand the choice to the opener. */
  function followUp(action: FollowUpAction): void {
    const handler = followUpHandler;
    followUpHandler = null;
    dialogOpen.value = false;
    loginPhase.value = 'idle';
    handler?.(action);
  }

  /** Disconnect Nous Portal. Rejects with the API error so ConfirmInline can show it. */
  async function disconnect(): Promise<void> {
    await logoutNous();
    await load();
  }

  /** Fixtures, development only: end the waiting login as approved, declined, … */
  function simulate(outcome: LoginOutcome): void {
    simulateNousLogin(outcome);
    void poll();
  }

  /** Refresh provider statuses in the background (paused while the tab is hidden). */
  function startAutoRefresh(intervalMs = REFRESH_INTERVAL_MS): void {
    if (refreshTimer !== null) return;
    refreshTimer = setInterval(() => {
      if (!isHidden()) void load();
    }, intervalMs);
  }
  function stopAutoRefresh(): void {
    if (refreshTimer !== null) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  /** Stop every timer (tests, HMR). */
  function dispose(): void {
    stopPolling();
    stopAutoRefresh();
  }

  return {
    // state
    providers,
    loaded,
    loading,
    error,
    loginPhase,
    userCode,
    verifyUrl,
    expiresAt,
    loginError,
    billingUrl,
    reconnecting,
    dialogOpen,
    origin,
    context,
    now,
    // getters
    nous,
    keyProviders,
    nousStatus,
    nousConnected,
    anyConnected,
    nousInUse,
    needsAttention,
    bannerKind,
    pausedCount,
    secondsLeft,
    countdown,
    approvalLeft,
    dialogHeading,
    // actions
    load,
    connect,
    retry,
    cancel,
    openDialog,
    closeDialog,
    followUp,
    disconnect,
    simulate,
    poll,
    startAutoRefresh,
    stopAutoRefresh,
    dispose,
  };
});
