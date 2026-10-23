/**
 * What the guard lets through to the Docker Engine API.
 *
 * The guard is the only process with the Docker socket, which is root on the
 * host (and, under Colima or Docker Desktop, read-write access to the user's
 * home). The worker talks to the guard instead, and can therefore only create,
 * observe and remove sandboxed trial containers of the pinned image. Every
 * other endpoint is refused, and every create body is checked field by field:
 * an unknown field is a refusal, so a new Docker option cannot slip through.
 *
 * The rule is about the sandbox, not about what runs inside it: the command,
 * environment and working directory are free, because any process inside the
 * sandbox is equally confined.
 */
import { z } from 'zod';

export interface GuardConfig {
  /** Image reference trials must use, e.g. `hermes-evals/trial:v0.22.4-4d04303`. */
  trialImage: string;
  /** Named volume holding every attempt's home and workspace. */
  trialVolume: string;
  /** Internal networks a trial may join, one per concurrent slot. */
  trialNetworks: readonly string[];
}

export type Decision =
  /** `path` is the normalised path and query the guard forwards: never the raw request URL. */
  | { allow: true; kind: RouteKind; path: string; containerId?: string }
  | { allow: false; status: number; reason: string };

export type RouteKind =
  | 'ping'
  | 'version'
  | 'info'
  | 'image-inspect'
  | 'container-list'
  | 'container-create'
  | 'container-op';

/** Operations allowed on an existing container (which must carry the trial label), and their query parameters. */
const CONTAINER_OPS: Record<string, { methods: string[]; params: Record<string, RegExp> }> = {
  start: { methods: ['POST'], params: {} },
  stop: { methods: ['POST'], params: { t: /^\d{1,3}$/ } },
  kill: { methods: ['POST'], params: { signal: /^(SIGKILL|SIGTERM|KILL|TERM)$/ } },
  wait: { methods: ['POST'], params: { condition: /^(next-exit|not-running|removed)$/ } },
  logs: {
    methods: ['GET'],
    params: {
      follow: /^(0|1|true|false)$/,
      stdout: /^(0|1|true|false)$/,
      stderr: /^(0|1|true|false)$/,
      timestamps: /^(0|1|true|false)$/,
      since: /^\d{1,12}$/,
      tail: /^(all|\d{1,7})$/,
    },
  },
  json: { methods: ['GET'], params: {} },
};
const DELETE_PARAMS: Record<string, RegExp> = {
  force: /^(0|1|true|false)$/,
  v: /^(0|1|true|false)$/,
};
const LIST_PARAMS: Record<string, RegExp> = {
  all: /^(0|1|true|false)$/,
  filters: /^[\s\S]{0,2048}$/,
};

/** True when every query parameter is known for the route and has an expected value. */
function paramsAllowed(url: URL, allowed: Record<string, RegExp>): boolean {
  for (const [key, value] of url.searchParams) {
    const pattern = allowed[key];
    if (!pattern || !pattern.test(value)) return false;
  }
  return true;
}

export const TRIAL_LABEL = 'hermes-evals.role';
export const TRIAL_LABEL_VALUE = 'trial';

/** Container names the worker uses: one per run, or a probe for the isolation self-test. */
export const CONTAINER_NAME = /^hermes-evals-(run|probe)-[0-9A-HJKMNP-TV-Z]{26}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** A full container id or one of the worker's container names; never a short id prefix. */
export const CONTAINER_REF = /^([0-9a-f]{64}|hermes-evals-(run|probe)-[0-9A-HJKMNP-TV-Z]{26})$/;

/** Strips the optional `/v1.45` API version prefix. */
export function stripVersion(path: string): string {
  return path.replace(/^\/v\d+\.\d+(?=\/)/, '');
}

/** Decides whether a request may be forwarded, from its method and path alone. */
export function decideRoute(method: string, rawUrl: string, config: GuardConfig): Decision {
  // Only origin-form paths: anything else ('//host/x', 'http://...') could parse differently here and in Docker.
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
    return { allow: false, status: 400, reason: 'request target must be a plain path' };
  }
  return decidePath(method, rawUrl, config);
}

function decidePath(method: string, rawUrl: string, config: GuardConfig): Decision {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://guard');
  } catch {
    return { allow: false, status: 400, reason: 'malformed request target' };
  }
  const path = stripVersion(url.pathname);
  const forwarded = `${path}${url.search}`;
  const deny = (reason: string, status = 403): Decision => ({ allow: false, status, reason });

  const noParams = url.search === '';
  if (path === '/_ping' && (method === 'GET' || method === 'HEAD') && noParams)
    return { allow: true, kind: 'ping', path: forwarded };
  if (path === '/version' && method === 'GET' && noParams)
    return { allow: true, kind: 'version', path: forwarded };
  if (path === '/info' && method === 'GET' && noParams)
    return { allow: true, kind: 'info', path: forwarded };

  const image = /^\/images\/(.+)\/json$/.exec(path);
  if (image && method === 'GET') {
    let name: string;
    try {
      name = decodeURIComponent(image[1]!);
    } catch {
      return deny('malformed image name', 400);
    }
    return name === config.trialImage && noParams
      ? { allow: true, kind: 'image-inspect', path: forwarded }
      : deny('only the trial image may be inspected');
  }

  if (path === '/containers/json' && method === 'GET' && paramsAllowed(url, LIST_PARAMS))
    return { allow: true, kind: 'container-list', path: forwarded };

  if (path === '/containers/create' && method === 'POST') {
    const name = url.searchParams.get('name');
    if (!name || !CONTAINER_NAME.test(name))
      return deny('container name must be hermes-evals-run-<id> or hermes-evals-probe-<id>');
    if ([...url.searchParams.keys()].some((key) => key !== 'name'))
      return deny('unexpected create parameter');
    return { allow: true, kind: 'container-create', path: forwarded };
  }

  const op = /^\/containers\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (op) {
    const [, id, action] = op;
    if (!CONTAINER_REF.test(id!)) return deny('containers are addressed by full id or trial name');
    if (action === undefined) {
      return method === 'DELETE' && paramsAllowed(url, DELETE_PARAMS)
        ? { allow: true, kind: 'container-op', path: forwarded, containerId: id! }
        : deny('operation not allowed');
    }
    const allowedOp = CONTAINER_OPS[action];
    if (allowedOp?.methods.includes(method) && paramsAllowed(url, allowedOp.params)) {
      return { allow: true, kind: 'container-op', path: forwarded, containerId: id! };
    }
    return deny(`container operation ${method} ${action} is not allowed with these parameters`);
  }

  return deny(`${method} ${path} is not allowed`);
}

/** Forces the trial label onto a container list filter, so other containers stay invisible. */
export function restrictListQuery(rawUrl: string): string {
  const url = new URL(rawUrl, 'http://guard');
  let filters: Record<string, string[]> = {};
  const given = url.searchParams.get('filters');
  if (given) {
    const parsed: unknown = JSON.parse(given);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      filters = parsed as Record<string, string[]>;
  }
  const labels = Array.isArray(filters.label)
    ? filters.label.filter((l) => typeof l === 'string')
    : [];
  filters.label = [...labels, `${TRIAL_LABEL}=${TRIAL_LABEL_VALUE}`];
  url.searchParams.set('filters', JSON.stringify(filters));
  return `${url.pathname}${url.search}`;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const tmpfsOptions = z
  .string()
  .regex(
    /^rw,nosuid,nodev(,exec|,noexec)?,size=\d{1,4}m(,mode=1777)?$/,
    'tmpfs options must be rw,nosuid,nodev and sized',
  )
  .refine(
    (value) => Number(/size=(\d+)m/.exec(value)?.[1]) <= 1024,
    'tmpfs size must be at most 1024m',
  );

/**
 * The only container shape a trial may have. Strict at every level: any field
 * not listed here (Binds, Privileged, CapAdd, Devices, PidMode, NetworkMode
 * host, PortBindings, ExtraHosts, Dns, Runtime, ...) makes the create fail.
 */
export function createBodySchema(config: GuardConfig) {
  const networks: [string, ...string[]] = ['none', ...config.trialNetworks];
  const mount = z
    .object({
      Type: z.literal('volume'),
      Source: z.literal(config.trialVolume),
      Target: z.enum(['/opt/data', '/workspace']),
      ReadOnly: z.boolean().optional(),
      VolumeOptions: z
        .object({
          NoCopy: z.literal(true).optional(),
          Subpath: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}\/(home|workspace)$/),
        })
        .strict(),
    })
    .strict();

  return z
    .object({
      Image: z.literal(config.trialImage),
      Cmd: z.array(z.string()).max(256).optional(),
      Entrypoint: z.array(z.string()).max(16).optional(),
      Env: z
        .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*=/, 'env entries must be NAME=value'))
        .max(128)
        .optional(),
      User: z.literal('10000:10000'),
      WorkingDir: z.enum(['/workspace', '/opt/data']).optional(),
      Hostname: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
        .optional(),
      Labels: z.record(z.string().regex(/^hermes-evals\.[a-z.-]+$/), z.string().max(256)),
      AttachStdin: z.literal(false).optional(),
      AttachStdout: z.boolean().optional(),
      AttachStderr: z.boolean().optional(),
      Tty: z.literal(false).optional(),
      OpenStdin: z.literal(false).optional(),
      StdinOnce: z.literal(false).optional(),
      StopSignal: z.enum(['SIGTERM', 'SIGINT']).optional(),
      StopTimeout: z.number().int().min(1).max(60).optional(),
      HostConfig: z
        .object({
          ReadonlyRootfs: z.literal(true),
          CapDrop: z.tuple([z.literal('ALL')]),
          SecurityOpt: z.tuple([z.enum(['no-new-privileges', 'no-new-privileges:true'])]),
          Privileged: z.literal(false).optional(),
          Init: z.literal(true),
          AutoRemove: z.literal(false).optional(),
          NetworkMode: z.enum(networks),
          Mounts: z.array(mount).min(1).max(2),
          Tmpfs: z.object({ '/tmp': tmpfsOptions }).strict().optional(),
          Memory: z
            .number()
            .int()
            .min(64 * MIB)
            .max(4 * GIB),
          MemorySwap: z.number().int(),
          NanoCpus: z.number().int().min(1).max(4_000_000_000),
          PidsLimit: z.number().int().min(1).max(4096),
          ShmSize: z.number().int().min(0).max(GIB).optional(),
          Ulimits: z
            .array(
              z
                .object({
                  Name: z.literal('nofile'),
                  Soft: z.number().int().min(1).max(65_536),
                  Hard: z.number().int().min(1).max(65_536),
                })
                .strict(),
            )
            .max(1)
            .optional(),
          LogConfig: z
            .object({
              Type: z.literal('json-file'),
              Config: z
                .object({
                  'max-size': z.string().regex(/^\d{1,3}m$/),
                  'max-file': z
                    .string()
                    .regex(/^[1-5]$/)
                    .optional(),
                })
                .strict(),
            })
            .strict()
            .optional(),
          RestartPolicy: z
            .object({ Name: z.enum(['no', '']) })
            .strict()
            .optional(),
        })
        .strict(),
      NetworkingConfig: z
        .object({
          EndpointsConfig: z.record(z.string(), z.object({}).strict()),
        })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((body, ctx) => {
      const host = body.HostConfig;
      if (host.MemorySwap !== host.Memory) {
        ctx.addIssue({ code: 'custom', message: 'MemorySwap must equal Memory (no swap)' });
      }
      if (body.Labels[TRIAL_LABEL] !== TRIAL_LABEL_VALUE) {
        ctx.addIssue({
          code: 'custom',
          message: `label ${TRIAL_LABEL}=${TRIAL_LABEL_VALUE} is required`,
        });
      }
      const attempt = body.Labels['hermes-evals.attempt'];
      if (!attempt || !ULID.test(attempt)) {
        ctx.addIssue({
          code: 'custom',
          message: 'label hermes-evals.attempt must be the attempt id',
        });
      }
      const targets = new Set<string>();
      for (const m of host.Mounts) {
        if (targets.has(m.Target))
          ctx.addIssue({ code: 'custom', message: `${m.Target} is mounted twice` });
        targets.add(m.Target);
        const [id, part] = m.VolumeOptions.Subpath.split('/');
        if (id !== attempt) {
          ctx.addIssue({
            code: 'custom',
            message: 'a trial may only mount its own attempt directory',
          });
        }
        const expected = m.Target === '/opt/data' ? 'home' : 'workspace';
        if (part !== expected) {
          ctx.addIssue({ code: 'custom', message: `${m.Target} must mount <attempt>/${expected}` });
        }
      }
      const endpoints = Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {});
      if (endpoints.some((name) => name !== host.NetworkMode)) {
        ctx.addIssue({
          code: 'custom',
          message: 'a trial joins exactly one network, its NetworkMode',
        });
      }
    });
}

export type TrialCreateBody = z.infer<ReturnType<typeof createBodySchema>>;

/** Validates a create body; returns the parsed body or the reasons it was refused. */
export function checkCreateBody(
  body: unknown,
  config: GuardConfig,
): { ok: true; body: TrialCreateBody } | { ok: false; reasons: string[] } {
  const result = createBodySchema(config).safeParse(body);
  if (result.success) return { ok: true, body: result.data };
  return {
    ok: false,
    reasons: result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
    ),
  };
}
