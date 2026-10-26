/**
 * The inspector's Launch record section (UI_FLOWS 18, plan 13): the trial
 * container as launched, the exact Hermes command and config.yaml, enough
 * to reproduce the attempt by hand.
 *
 * The stored record (attempts.launch_record) holds argv, config.yaml, the
 * inputs and the Hermes build, and the runner keeps the container as
 * launched beside them (`container`: image, slot network, limits, disk cap;
 * not in the shared schema yet). A record without it is drawn from the
 * trial-spec constants every trial uses and the image the worker's
 * isolation self-test ran. Secret values never appear: the run token in the
 * command always shows as ‹run token, revoked›, whatever argv holds, and an
 * MCP value as `<from env NAME>`.
 *
 * Phase 6 records add how the skills loaded (P5), the home seeds copied in
 * (P1, the inputs of source `home_seed`) and the background review intervals
 * config.yaml set (P3). An older record reads as preload, no seeds, and no
 * intervals: it left Hermes's defaults implicit.
 */
import { LaunchRecordSchema, type LaunchRecordView } from '@hermes-evals/shared';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { WorkerSandboxSchema } from '../../database/schema/worker-sandbox.js';
import { DEFAULT_DISK_LIMIT } from '../../sandbox/trial-files.js';
import { DEFAULT_LIMITS, TRIAL_HOME, TRIAL_WORKSPACE } from '../../sandbox/trial-spec.js';
import type { AttemptRecord, WorkerRecord } from './rows.js';

export const RUN_TOKEN_PLACEHOLDER = '‹run token, revoked›';

/** Flags the displayed command starts a new line at, as the design writes it. */
const LINE_BREAK_FLAGS = new Set(['--provider', '--base-url', '-t']);

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
const quote = (arg: string) => (SAFE_ARG.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

/**
 * argv as a shell command: `hermes` for the entrypoint, arguments quoted
 * where a shell needs it, the run token masked, and a line break before the
 * provider, gateway and toolset flags.
 */
export function commandLine(argv: readonly string[]): string {
  const parts: string[] = [];
  const broken = new Set<string>();
  argv.forEach((arg, i) => {
    let shown: string;
    if (i === 0 && /(^|\/)hermes$/.test(arg)) shown = 'hermes';
    else if (argv[i - 1] === '--api-key') shown = RUN_TOKEN_PLACEHOLDER;
    else if (arg.startsWith('--api-key=')) shown = `--api-key=${RUN_TOKEN_PLACEHOLDER}`;
    else shown = quote(arg);
    if (i > 0 && LINE_BREAK_FLAGS.has(arg) && !broken.has(arg)) {
      broken.add(arg);
      parts.push(`\\\n  ${shown}`);
    } else {
      parts.push(shown);
    }
  });
  return parts.join(' ');
}

/**
 * config.yaml as shown: `${NAME}` references, as Hermes reads them, written
 * the way every page names a secret, and any `api_key:` value masked. The
 * runner never writes a key there (the token travels in argv); the mask
 * keeps it that way on screen should one ever appear.
 */
export const showSecretRefs = (yaml: string): string =>
  yaml
    .replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, '<from env $1>')
    .replace(/^(\s*api_key:[ \t]*)\S.*$/gm, `$1"${RUN_TOKEN_PLACEHOLDER}"`);

/** One MCP server's entry of config.yaml, as YAML; null when config.yaml has none for it. */
function mcpEntryYaml(configYaml: string, name: string): string | null {
  try {
    const doc: unknown = parse(configYaml);
    const servers = (doc as { mcp_servers?: unknown } | null)?.mcp_servers;
    if (servers === null || typeof servers !== 'object') return null;
    const entry: unknown = (servers as Record<string, unknown>)[name];
    return entry === undefined ? null : stringify({ mcp_servers: { [name]: entry } }).trimEnd();
  } catch {
    return null;
  }
}

const sizeLabel = (mib: number) => (mib >= 1024 ? `${mib / 1024} GB` : `${mib} MB`);

const positive = z.number().positive();
const positiveInt = z.number().int().positive();
const count = z.number().int().nonnegative();

/**
 * The part of the runner's `container` block the view draws
 * (execution/attempt/launch.ts LaunchContainerRecord). Each field is read on
 * its own, so one the runner renames or drops falls back alone.
 */
const StoredContainerSchema = z.object({
  image: z.string().min(1).optional().catch(undefined),
  network: z.string().min(1).optional().catch(undefined),
  user: z.string().min(1).optional().catch(undefined),
  read_only_root: z.boolean().optional().catch(undefined),
  limits: z
    .object({ memory_mib: positive, cpus: positive, pids: positiveInt, tmp_mib: positive })
    .optional()
    .catch(undefined),
  mounts: z
    .array(z.object({ target: z.string().min(1) }))
    .optional()
    .catch(undefined),
  disk_cap: z.object({ bytes: count, files: count }).optional().catch(undefined),
});
type StoredContainer = z.infer<typeof StoredContainerSchema>;

const storedContainer = (record: unknown): StoredContainer => {
  const parsed = StoredContainerSchema.safeParse((record as { container?: unknown }).container);
  return parsed.success ? parsed.data : {};
};

/** The workspace and home mounts, named as the design names them; others by their target. */
function mountsOf(stored: StoredContainer['mounts']): Array<{ name: string; target: string }> {
  if (!stored || stored.length === 0) {
    return [
      { name: 'home', target: TRIAL_HOME },
      { name: 'workspace', target: TRIAL_WORKSPACE },
    ];
  }
  return stored.map(({ target }) => ({
    name: target === TRIAL_HOME ? 'home' : target === TRIAL_WORKSPACE ? 'workspace' : target,
    target,
  }));
}

export interface LaunchRecordInput {
  /** attempts.launch_record as stored; null before the runner wrote it. */
  record: unknown;
  attempt: Pick<AttemptRecord, 'startedAt' | 'exitCode'>;
  worker: Pick<WorkerRecord, 'hostname' | 'sandbox'> | null;
  /** The image to name when the worker reported none (TRIAL_IMAGE). */
  fallbackImage: string;
}

/** The view of a stored launch record, or null when there is none or it does not parse. */
export function launchRecordView(input: LaunchRecordInput): LaunchRecordView | null {
  const parsed = LaunchRecordSchema.safeParse(input.record);
  if (!parsed.success) return null;
  const record = parsed.data;
  const sandbox = WorkerSandboxSchema.safeParse(input.worker?.sandbox);
  const stored = storedContainer(input.record);
  const limits = stored.limits ?? {
    memory_mib: DEFAULT_LIMITS.memoryMiB,
    cpus: DEFAULT_LIMITS.cpus,
    pids: DEFAULT_LIMITS.pids,
    tmp_mib: DEFAULT_LIMITS.tmpMiB,
  };
  const diskCap = stored.disk_cap ?? {
    bytes: DEFAULT_DISK_LIMIT.maxBytes,
    files: DEFAULT_DISK_LIMIT.maxEntries,
  };
  const image = stored.image ?? (sandbox.success ? sandbox.data.image : input.fallbackImage);
  // The self-test's digest is of its image; another image's digest is not known here.
  const digest =
    sandbox.success && sandbox.data.image === image ? sandbox.data.image_digest : undefined;
  const configYaml = showSecretRefs(record.config_yaml);
  return {
    container: {
      image,
      digest: digest ?? 'not reported',
      hermes: `hermes-agent v${record.hermes.version} @ ${record.hermes.revision.slice(0, 7)}`,
      network: stored.network ?? 'trial slot network (internal)',
      user: stored.user ?? '10000:10000',
      imageFilesystem: stored.read_only_root === false ? 'writable' : 'read-only',
      limits: {
        memory: sizeLabel(limits.memory_mib),
        cpus: limits.cpus,
        processes: limits.pids,
        tmp: sizeLabel(limits.tmp_mib),
      },
      mounts: mountsOf(stored.mounts),
      diskCap: { bytes: diskCap.bytes, files: diskCap.files },
      worker: {
        name: input.worker?.hostname ?? 'unknown worker',
        startedAt: input.attempt.startedAt.toISOString(),
        exitCode: input.attempt.exitCode,
      },
      skills: record.skills.map((s) => ({
        name: s.name,
        version: s.version,
        contentHash: s.content_hash,
      })),
      // Records from before Phase 6 have no mode: every one of them preloaded.
      skillLoading: record.skill_loading ?? 'preload',
      mcpServers: record.mcp_servers.map((m) => ({
        name: m.name,
        version: Math.max(1, m.version),
        transport: m.transport,
        definition: mcpEntryYaml(configYaml, m.name) ?? `${m.name}: not in config.yaml`,
      })),
    },
    command: commandLine(record.argv),
    commandNote: 'The run token is issued for this run only and revoked when it ends.',
    configPath: record.config_path,
    configYaml,
    configNote:
      record.mcp_servers.length > 0
        ? "Secret values show as <from env NAME>: a stdio server's values are set in the container environment and are readable by the agent; an http server's header values are added by egress and never enter the run."
        : null,
    homeSeeds: record.inputs
      .filter((input) => input.source === 'home_seed')
      .map(({ path, sha256 }) => ({ path, sha256 })),
    backgroundReview: record.background_review
      ? {
          memoryNudgeInterval: record.background_review.memory_nudge_interval,
          skillCreationNudgeInterval: record.background_review.skill_creation_nudge_interval,
        }
      : null,
  };
}
