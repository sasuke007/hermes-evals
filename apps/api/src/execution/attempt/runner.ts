/**
 * The AttemptRunner (execution/contracts.ts): everything that happens to one
 * attempt between the lifecycle's claim and its finish transaction (plan
 * 5.4, 8.2 to 8.5), with the database reached only through the AttemptSink.
 *
 *   secrets   stdio MCP values from the worker's environment, by name; the
 *             header variables of http MCP servers checked against egress
 *   build     fresh home and workspace: fixtures, documents, skills, config.yaml
 *   record    the launch record, before any container exists
 *   egress    register the attempt: token, network mode, model route, MCP routes
 *   run       the trial container, its output streamed into the sink
 *   egress    remove the attempt (the token dies), keep usage and the connection log
 *   classify  plan 8.4, with the MCP servers Hermes's errors.log says failed to start
 *   collect   the workspace, after the container is gone (owner permissions
 *             the agent removed restored first), and the home's memories/
 *             (Phase 6 P2); then delete the home
 *
 * Anything the agent, the trial or its setup did is an outcome. It throws
 * only what the lifecycle must handle itself: LeaseLostError and
 * WorkerShutdownError, or the error of a sink write (nothing more can be
 * recorded). By then the container is stopped and removed and the attempt is
 * gone from egress; the trial directories are left for recovery, because
 * another owner may now be responsible for them: recovery's finalise deletes
 * the home once it has confirmed the container gone, and retention the rest.
 *
 * One runner serves every attempt of a worker; all per-attempt state lives in
 * run(), so attempts run concurrently.
 */
import { basename, dirname, join } from 'node:path';
import type {
  EgressClient,
  EgressLogEntry,
  EgressRegistration,
  EgressUsage,
} from '../../sandbox/egress-client.js';
import type { EngineClient } from '../../sandbox/engine-client.js';
import { forceRemoveTree, prepareTrialDirs } from '../../sandbox/trial-runner.js';
import type { BlobStore } from '../../storage/blob-store.js';
import {
  LeaseLostError,
  WorkerShutdownError,
  type AttemptOutcome,
  type AttemptPlan,
  type AttemptRunner,
  type AttemptSink,
} from '../contracts.js';
import { ATTEMPT_TOKEN_ENV, egressModelAccess } from '../providers-map.js';
import { classifyAttempt, tokenCapRefusalOf } from './classify.js';
import { collectTrialFiles, type Collection } from './collect.js';
import { AttemptSetupError } from './errors.js';
import { EventBatcher } from './event-batcher.js';
import { finalEvents } from './final-events.js';
import { buildTrialLaunch, type TrialLaunch } from './launch.js';
import { materialiseTrial, type InputFile } from './materialise.js';
import { mcpStartFailures } from './mcp-start.js';
import { networkEvents } from './network-events.js';
import { Redactor } from './redaction.js';
import {
  DEFAULT_RUNNER_SETTINGS,
  IMAGE_DEFAULT_PATH,
  tokenCheck,
  type AttemptRunnerSettings,
} from './settings.js';
import { checkHttpMcpServers, checkMcpRoutes, httpServers, stdioSecretValues } from './secrets.js';
import { StderrCapture } from './stderr-capture.js';
import { attemptConfig, configYaml } from './trial-config.js';
import { runTrialSession, type SessionResult } from './trial-session.js';

/** What the runner logs; PinoLogger fits. */
export interface AttemptLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface AttemptRunnerDeps {
  /** The guard-backed engine (SandboxService.engine), or FakeEngine in tests. */
  engine: EngineClient;
  egress: EgressClient;
  blobs: BlobStore;
  /** DATA_DIR/skills. */
  skillsDir: string;
  image: string;
  volume: string;
  /** This worker's Docker daemon id (engine.info().ID). */
  hostId: string;
  /** Where stdio MCP values come from. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** The trial image's PATH, for the launch record. Default IMAGE_DEFAULT_PATH. */
  imagePath?: string;
  settings?: Partial<AttemptRunnerSettings>;
  logger?: AttemptLogger;
  now?: () => number;
}

type EgressReport = { usage: EgressUsage; log: EgressLogEntry[] };

/** What finish() needs from the run. */
interface Ran {
  plan: AttemptPlan;
  redactor: Redactor;
  /** Set when the attempt never reached a container. */
  setupError: string | null;
  cancelledBeforeStart: boolean;
  session: SessionResult | null;
  manifest: ReadonlyMap<string, InputFile>;
  stderr: StderrCapture | null;
  report: EgressReport | null;
  /** Whether this run created the trial directories (and so may delete the home). */
  ownsDirs: boolean;
  /** Events the batcher dropped for a full queue; the trial was stopped for it. */
  droppedEvents: number;
}

const isHandBack = (reason: unknown): boolean =>
  reason instanceof LeaseLostError || reason instanceof WorkerShutdownError;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const codeOf = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? messageOf(err);

export class TrialAttemptRunner implements AttemptRunner {
  private readonly settings: AttemptRunnerSettings;
  private readonly now: () => number;

  constructor(private readonly deps: AttemptRunnerDeps) {
    this.settings = { ...DEFAULT_RUNNER_SETTINGS, ...deps.settings };
    this.now = deps.now ?? Date.now;
  }

  async run(plan: AttemptPlan, sink: AttemptSink, signal: AbortSignal): Promise<AttemptOutcome> {
    if (signal.aborted && isHandBack(signal.reason)) throw signal.reason;
    const ran: Ran = {
      plan,
      redactor: new Redactor({ [ATTEMPT_TOKEN_ENV]: plan.token }),
      setupError: null,
      cancelledBeforeStart: signal.aborted,
      session: null,
      manifest: new Map(),
      stderr: null,
      report: null,
      ownsDirs: false,
      droppedEvents: 0,
    };
    if (ran.cancelledBeforeStart) return this.finish(ran);

    let values: Record<string, string>;
    try {
      values = stdioSecretValues(plan.configuration.mcpServers, this.deps.env ?? process.env);
      ran.redactor = new Redactor({ ...values, [ATTEMPT_TOKEN_ENV]: plan.token });
      await this.checkHttpMcp(plan);
      await this.prepareDirs(plan);
      ran.ownsDirs = true;
    } catch (err) {
      if (!(err instanceof AttemptSetupError)) throw err;
      // Nothing of this attempt exists, and a directory that was already there is not ours.
      ran.setupError = err.message;
      return this.finish(ran);
    }

    const batcher = new EventBatcher(sink, {
      maxBatch: this.settings.flushEvents,
      intervalMs: this.settings.flushIntervalMs,
      maxQueued: this.settings.maxQueuedEvents,
      failAfterMs: this.settings.sinkRetryMs,
    });
    const stderr = new StderrCapture(join(plan.paths.root, 'stderr.log'));
    ran.stderr = stderr;
    let registered = false;
    // Set before the call: a register that timed out may still have reached egress.
    let registering = false;
    try {
      const launch = await this.build(plan, values, ran);
      if (launch && signal.aborted) {
        if (isHandBack(signal.reason)) throw signal.reason;
        ran.cancelledBeforeStart = true;
      } else if (launch) {
        await sink.recordLaunch(launch.record);
        try {
          registering = true;
          await this.deps.egress.register(plan.attemptId, this.registration(plan, launch));
          registered = true;
        } catch (err) {
          ran.setupError = `Egress did not accept the attempt: ${ran.redactor.text(messageOf(err))}`;
        }
      }
      if (launch && registered) {
        ran.session = await runTrialSession({
          engine: this.deps.engine,
          hostId: this.deps.hostId,
          spec: launch.spec,
          deadlineMs: launch.deadlineMs,
          stopGraceS: this.settings.stopGraceS,
          diskLimit: { ...this.settings.disk, roots: [plan.paths.home, plan.paths.workspace] },
          outputLimitBytes: this.settings.outputLimitBytes,
          maxLines: this.settings.maxEvents,
          cancelPollMs: this.settings.cancelPollMs,
          sink,
          signal,
          batcher,
          redactor: ran.redactor,
          stderr,
          now: this.now,
        });
      }
    } finally {
      await stderr.close();
      // The token dies with the registration, whatever happened above.
      if (registering) ran.report = await this.removeFromEgress(plan.attemptId);
    }
    const fatal = ran.session?.fatal;
    if (fatal) {
      // Keep what was streamed if the sink still takes it (a shutdown); a lost lease refuses it.
      await batcher.close().catch(() => {});
      throw fatal.error;
    }
    await batcher.close();
    ran.droppedEvents = batcher.dropped;
    return this.finish(ran);
  }

  /** Materialises the trial and builds its launch; a setup failure is recorded on `ran`. */
  private async build(
    plan: AttemptPlan,
    values: Readonly<Record<string, string>>,
    ran: Ran,
  ): Promise<TrialLaunch | null> {
    try {
      const yaml = configYaml(attemptConfig(plan));
      const built = await materialiseTrial(plan, yaml, this.deps);
      ran.manifest = built.manifest;
      return buildTrialLaunch(
        plan,
        { configYaml: yaml, inputs: built.inputs, values },
        {
          image: this.deps.image,
          volume: this.deps.volume,
          imagePath: this.deps.imagePath ?? IMAGE_DEFAULT_PATH,
          deadlineGraceS: this.settings.deadlineGraceS,
          stopGraceS: this.settings.stopGraceS,
          diskLimit: this.settings.disk,
          limits: this.settings.limits,
        },
        this.now(),
      );
    } catch (err) {
      ran.setupError =
        err instanceof AttemptSetupError
          ? err.message
          : `The trial could not be prepared: ${ran.redactor.text(messageOf(err))}`;
      return null;
    }
  }

  /** Classifies, collects, deletes the home, and assembles the outcome. */
  private async finish(ran: Ran): Promise<AttemptOutcome> {
    const { plan, redactor, session } = ran;
    const trial = session?.trial ?? null;
    const stderrTail = ran.stderr?.tailLines(redactor) ?? null;
    // Read from the home before it is deleted below; only a trial that ran can have failed one.
    const failedServers =
      trial && ran.ownsDirs
        ? await mcpStartFailures(plan.paths.home, plan.configuration.mcpServers)
        : [];
    const classification = classifyAttempt({
      trial,
      setupError: ran.setupError ?? session?.setupError ?? null,
      engineError: session?.engineError ?? null,
      cancelled: ran.cancelledBeforeStart || (session?.cancelled ?? false),
      result: session?.result ?? null,
      sawInit: session?.sawInit ?? false,
      stderrTail,
      mcpStartFailures: failedServers,
      tokenCapRefusal: tokenCapRefusalOf(ran.report?.log ?? []),
      runBudgetS: plan.limits.runBudgetS,
      deadlineGraceS: this.settings.deadlineGraceS,
      memoryMiB: this.settings.limits.memoryMiB,
    });

    // Collected only once a container ran: before that the workspace holds only the inputs.
    let collection: Collection | null = null;
    if (session && session.setupError === null) {
      collection = await this.collect(plan, ran.manifest);
    }
    if (ran.ownsDirs) {
      // The container is gone (runTrial removed it), so nothing changes under the walk.
      await forceRemoveTree(plan.paths.home).catch((err: unknown) =>
        this.deps.logger?.warn({ attemptId: plan.attemptId, err: codeOf(err) }, 'home not deleted'),
      );
    }
    if (collection && ran.stderr) {
      collection.event.payload = { ...collection.event.payload, stderr_lines: ran.stderr.lines };
    }
    if (collection && ran.report) {
      const check = tokenCheck(classification.tokens, ran.report.usage);
      collection.event.payload = { ...collection.event.payload, token_check: check };
      if (check.agrees === false) {
        this.deps.logger?.warn(
          { attemptId: plan.attemptId, check },
          'result tokens differ from egress usage',
        );
      }
    }

    const events = finalEvents({
      network: networkEvents(ran.report?.log ?? [], plan.configuration.provider, this.now()),
      trial,
      classification,
      hermesResult: session?.result != null,
      droppedEvents: ran.droppedEvents,
      collected: collection?.event ?? null,
      stopGraceS: this.settings.stopGraceS,
      now: this.now(),
    }).map((event) => ({ ...event, payload: redactor.json(event.payload) }));
    const errorMessage =
      classification.errorMessage === null ? null : redactor.text(classification.errorMessage);
    return {
      ...classification,
      errorMessage,
      durationMs: trial?.durationMs ?? null,
      stderrTail,
      redactions: redactor.count,
      finalEvents: events,
      artifacts: collection?.artifacts ?? [],
      egressUsage: ran.report?.usage ?? null,
    };
  }

  /**
   * Collection never fails the attempt: a platform fault is recorded on the
   * `collected` event. The home's memories/ is collected here too, before
   * finish() deletes the home.
   */
  private async collect(
    plan: AttemptPlan,
    manifest: ReadonlyMap<string, InputFile>,
  ): Promise<Collection> {
    try {
      return await collectTrialFiles({
        workspace: plan.paths.workspace,
        home: plan.paths.home,
        manifest,
        homeSeeds: plan.task.homeSeeds,
        blobs: this.deps.blobs,
        now: this.now,
      });
    } catch (err) {
      this.deps.logger?.warn(
        { attemptId: plan.attemptId, err: messageOf(err) },
        'workspace not collected',
      );
      return {
        artifacts: [],
        event: {
          ts: this.now(),
          type: 'platform',
          payload: { type: 'platform', subtype: 'collected', files: 0, error: messageOf(err) },
        },
      };
    }
  }

  /**
   * The attempt's http MCP servers must be routable and have every header
   * variable in this worker's egress, asked now rather than read from a
   * heartbeat. Throws AttemptSetupError naming what is wrong.
   */
  private async checkHttpMcp(plan: AttemptPlan): Promise<void> {
    const http = httpServers(plan.configuration.mcpServers);
    if (http.length === 0) return;
    checkMcpRoutes(http);
    let held: string[];
    try {
      held = await this.deps.egress.envNames();
    } catch (err) {
      throw new AttemptSetupError(
        `Egress could not be asked which variables it holds (${messageOf(err)}), so the MCP ` +
          `servers ${http.map((s) => s.name).join(', ')} cannot start.`,
      );
    }
    checkHttpMcpServers(http, held);
  }

  /** Creates the attempt's fresh directories where the plan says they are. */
  private async prepareDirs(plan: AttemptPlan): Promise<void> {
    const { root, home, workspace } = plan.paths;
    if (
      basename(root) !== plan.attemptId ||
      home !== join(root, 'home') ||
      workspace !== join(root, 'workspace')
    ) {
      throw new AttemptSetupError(`The trial paths do not belong to attempt ${plan.attemptId}.`);
    }
    try {
      await prepareTrialDirs(dirname(root), plan.attemptId);
    } catch (err) {
      throw new AttemptSetupError(
        `The trial directory could not be created fresh (${codeOf(err)}).`,
      );
    }
  }

  private registration(plan: AttemptPlan, launch: TrialLaunch): EgressRegistration {
    const { configuration } = plan;
    // Allowlist mode refuses every CONNECT; only web and browser toolsets need the public internet.
    const publicMode = configuration.toolsets.some((t) => t === 'web' || t === 'browser');
    return {
      token: plan.token,
      mode: publicMode ? 'public' : 'allowlist',
      allowHosts: [],
      ...egressModelAccess(configuration),
      ...(this.settings.maxTokens ? { maxTokens: this.settings.maxTokens } : {}),
      expiresAt: launch.egressExpiresAt,
      mcp: configuration.mcpServers.flatMap((server) =>
        server.definition.transport === 'http' && server.definition.url !== null
          ? [
              {
                name: server.name,
                url: server.definition.url,
                headers: server.definition.headers.map((h) => ({ header: h.header, env: h.env })),
              },
            ]
          : [],
      ),
    };
  }

  /** Removes the attempt from egress; never throws, because the trial is already over. */
  private async removeFromEgress(attemptId: string): Promise<EgressReport | null> {
    try {
      return await this.deps.egress.remove(attemptId);
    } catch (err) {
      this.deps.logger?.warn(
        { attemptId, err: messageOf(err) },
        'egress remove failed; the registration expires on its own',
      );
      return null;
    }
  }
}
