/**
 * The trial's launch contract (plan 8.2): the `hermes chat` command, the
 * container environment, the container spec docker-guard accepts, and the
 * launch record that lets anyone reproduce the attempt by hand.
 *
 * Secrets: the container environment carries the attempt token (proxy
 * credentials and the MCP gateway's bearer) and the stdio MCP values, and the
 * command line carries the token as `--api-key`. The launch record carries
 * none of them: argv shows the token as `<attempt-token>`, the environment is
 * listed by name, and config.yaml shows each `${NAME}` as `<from env NAME>`.
 *
 * Skills (Phase 6 P5): both modes copy them into home/skills/<name>/
 * (materialise.ts). `preload` passes `-s <name>` per skill, so Hermes loads
 * each into the session at start; `on_demand` passes none, and the plan has
 * already added the `skills` toolset (plannedToolsets, lifecycle/plan.ts),
 * so the agent lists and opens them itself. With memory on the plan has
 * added the `memory` toolset the same way, so the agent can save to the
 * stores memory puts in its prompt. Either toolset shows in the record's
 * argv (`-t`) and config.yaml (`toolsets`), both built from that one list.
 */
import type { HomeMemoryRecord, LaunchContainerRecord, LaunchRecord } from '@hermes-evals/shared';
import {
  HERMES_ENTRYPOINT,
  TRIAL_HOME,
  TRIAL_WORKSPACE,
  type TrialLimits,
  type TrialSpec,
} from '../../sandbox/trial-spec.js';
import type { AttemptPlan } from '../contracts.js';
import { ATTEMPT_TOKEN_ENV, hermesModelArgs } from '../providers-map.js';
import {
  backgroundReviewRecord,
  displayConfigYaml,
  TRIAL_CONFIG_PATH,
  trialToolsets,
} from './trial-config.js';

/** How the launch record shows the attempt token in argv. */
export const ATTEMPT_TOKEN_PLACEHOLDER = '<attempt-token>';

/** The variables whose values carry the attempt token. */
const TOKEN_ENV_NAMES = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  ATTEMPT_TOKEN_ENV,
];

export interface LaunchSettings {
  image: string;
  volume: string;
  /** The PATH the trial image sets, for the record; the trial is not given one. */
  imagePath: string;
  /** Seconds after the run budget before the container is stopped (plan: 60). */
  deadlineGraceS: number;
  /** Seconds between SIGTERM and SIGKILL (plan: 10). */
  stopGraceS: number;
  diskLimit: { maxBytes: number; maxEntries: number };
  limits: TrialLimits;
}

/**
 * The launch record this runner writes: LaunchRecordSchema with the slot
 * network, the container (LaunchContainerRecordSchema) and what memory
 * decided about the home (`home_memory`, Phase 8 G9) always present. The
 * inspector reads all three (runs/views/launch-record.ts).
 */
export type AttemptLaunchRecord = LaunchRecord & {
  network: string;
  container: LaunchContainerRecord;
  home_memory: HomeMemoryRecord;
};

/**
 * Seconds the container's `hermes-evals.deadline` label adds beyond the
 * SIGKILL deadline. The label is computed here, before the launch record,
 * the egress registration (up to 10 s), create and start, while runTrial's
 * own timer starts only after start and then waits out the stop grace and
 * up to 5 s of log drain. Recovery's sweep removes a container past its
 * label, so the label must never fall inside the runner's own stop.
 */
export const SWEEP_MARGIN_S = 120;

export interface TrialLaunch {
  spec: TrialSpec;
  record: AttemptLaunchRecord;
  /** From start to SIGTERM: the run budget plus the grace. */
  deadlineMs: number;
  /** Epoch ms when egress stops honouring the token: the SIGKILL deadline plus 60 s. */
  egressExpiresAt: number;
}

/** `hermes chat` for the attempt (plan 8.2), the token in clear: only the container sees this. */
export function hermesChatCmd(plan: AttemptPlan): string[] {
  const { configuration } = plan;
  const toolsets = trialToolsets(
    configuration.toolsets,
    configuration.mcpServers.map((s) => s.name),
  );
  return [
    'chat',
    '--query-file',
    `${TRIAL_HOME}/task.txt`,
    '--oneshot',
    '--format',
    'stream-json',
    ...hermesModelArgs(configuration.provider, configuration.model, plan.token),
    // An empty -t list is left out rather than passed as '' (whose meaning Hermes does not document).
    ...(toolsets.length > 0 ? ['-t', toolsets.join(',')] : []),
    // On demand loading passes no -s: the skills toolset finds them (plannedToolsets).
    ...(configuration.skillLoading === 'on_demand'
      ? []
      : configuration.skills.flatMap((skill) => ['-s', skill.name])),
    '--max-turns',
    String(plan.limits.maxTurns),
    '--yolo',
    '--in',
    TRIAL_WORKSPACE,
  ];
}

/**
 * The container environment. The stdio values come first, so a platform
 * variable can never be replaced by one (reserved names are refused before
 * this, secrets.ts).
 */
export function trialEnv(
  plan: AttemptPlan,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const proxy = `http://${plan.attemptId}:${plan.token}@egress:3128`;
  return {
    ...values,
    HOME: TRIAL_HOME,
    HERMES_HOME: TRIAL_HOME,
    HERMES_WRITE_SAFE_ROOT: `${TRIAL_WORKSPACE}:${TRIAL_HOME}`,
    XDG_RUNTIME_DIR: `${TRIAL_HOME}/.run`,
    TMPDIR: '/tmp',
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    NO_PROXY: 'egress',
    no_proxy: 'egress',
    NODE_USE_ENV_PROXY: '1',
    [ATTEMPT_TOKEN_ENV]: plan.token,
  };
}

export function buildTrialLaunch(
  plan: AttemptPlan,
  input: {
    /** config.yaml as written to the home (references only). */
    configYaml: string;
    inputs: LaunchRecord['inputs'];
    /** What materialisation did with the home seeds, and whether home/memories is collected. */
    homeMemory: HomeMemoryRecord;
    /** stdio MCP values: into the environment, never into the record. */
    values: Readonly<Record<string, string>>;
  },
  settings: LaunchSettings,
  now = Date.now(),
): TrialLaunch {
  const cmd = hermesChatCmd(plan);
  const env = trialEnv(plan, input.values);
  const budget = plan.limits.runBudgetS;
  const killAfterS = budget + settings.deadlineGraceS + settings.stopGraceS;
  const deadlineUnix = Math.ceil(now / 1000 + killAfterS + SWEEP_MARGIN_S);
  const name = `hermes-evals-run-${plan.runId}`;
  const spec: TrialSpec = {
    name,
    runId: plan.runId,
    attemptId: plan.attemptId,
    image: settings.image,
    volume: settings.volume,
    network: plan.slot,
    cmd,
    env,
    deadline: deadlineUnix,
    limits: settings.limits,
  };
  const { configuration } = plan;
  const { limits } = settings;
  const record: AttemptLaunchRecord = {
    argv: [HERMES_ENTRYPOINT, ...cmd].map((arg) =>
      arg === plan.token ? ATTEMPT_TOKEN_PLACEHOLDER : arg,
    ),
    cwd: TRIAL_WORKSPACE,
    env: { HERMES_HOME: TRIAL_HOME, HOME: TRIAL_HOME, PATH: settings.imagePath },
    secret_env_names: [...new Set([...Object.keys(input.values), ...TOKEN_ENV_NAMES])].sort(),
    config_path: TRIAL_CONFIG_PATH,
    config_yaml: displayConfigYaml(input.configYaml),
    skills: configuration.skills.map((s) => ({
      skill_id: s.id,
      name: s.name,
      version: s.version,
      content_hash: s.contentHash,
    })),
    skill_loading: configuration.skillLoading,
    mcp_servers: configuration.mcpServers.map((s) => ({
      mcp_server_version_id: s.versionId,
      name: s.name,
      version: s.version,
      transport: s.transport,
      definition_hash: s.definitionHash,
    })),
    inputs: input.inputs,
    // The intervals config.yaml sets (trial-config.ts BACKGROUND_REVIEW), the same in every arm.
    background_review: backgroundReviewRecord(),
    // With memory off the seeds stayed out and home/memories is not collected (materialise.ts).
    home_memory: input.homeMemory,
    limits: {
      max_turns: plan.limits.maxTurns,
      run_budget_seconds: budget,
      deadline_seconds: killAfterS,
    },
    hermes: { version: plan.hermes.version, revision: plan.hermes.revision },
    network: plan.slot,
    container: {
      name,
      image: settings.image,
      network: plan.slot,
      user: '10000:10000',
      read_only_root: true,
      limits: {
        memory_mib: limits.memoryMiB,
        cpus: limits.cpus,
        pids: limits.pids,
        tmp_mib: limits.tmpMiB,
      },
      mounts: [
        { volume: settings.volume, subpath: `${plan.attemptId}/home`, target: TRIAL_HOME },
        {
          volume: settings.volume,
          subpath: `${plan.attemptId}/workspace`,
          target: TRIAL_WORKSPACE,
        },
      ],
      disk_cap: { bytes: settings.diskLimit.maxBytes, files: settings.diskLimit.maxEntries },
      stop_grace_seconds: settings.stopGraceS,
      deadline_unix: deadlineUnix,
      env_names: Object.keys(env).sort(),
    },
  };
  return {
    spec,
    record,
    deadlineMs: (budget + settings.deadlineGraceS) * 1000,
    egressExpiresAt: now + killAfterS * 1000 + 60_000,
  };
}
