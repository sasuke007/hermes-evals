/**
 * The one container shape a verifier script may run in (plan 14, R7).
 *
 * A verifier is the task author's Python script, which arrives with a suite,
 * and since Phase 5b also with a suite .zip a user imported. It runs in a
 * container of its own, created through the guard like a trial's, but
 * narrower than a trial in every respect:
 *
 * - the trial image's python3 as the entrypoint, nothing else;
 * - no network at all (`none`), never a slot network;
 * - one mount: a `verify-<id>` subpath of the trials volume at /check,
 *   read-only, holding the script's folder, the answer, the workspace and
 *   the home it judges;
 * - a read-only root, a small tmpfs /tmp, no capabilities, no new
 *   privileges, the trial uid, pids and memory limits;
 * - no environment but PATH.
 *
 * Containers are named `hermes-evals-verify-<id>` and the guard checks a
 * body under that name against this schema only (policy.ts): anything that
 * differs, such as a network, a writable mount, another image or an added
 * capability, is refused. They carry the trial label, so the worker can
 * operate on them and recovery sweeps one left behind once its deadline
 * label has passed.
 */
import { z } from 'zod';

/** The interpreter of the trial image; the only entrypoint a verifier container may have. */
export const VERIFIER_PYTHON = '/usr/local/bin/python3';
/** Where the verifier's read-only inputs are mounted. */
export const VERIFIER_MOUNT = '/check';

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
/** `hermes-evals-verify-<id>`: the name selects this schema. */
export const VERIFIER_NAME = new RegExp(`^hermes-evals-verify-(${ULID})$`);

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** A small tmpfs: rw, nosuid, nodev, never more than 256 MiB. */
const tmpfsOptions = z
  .string()
  .regex(
    /^rw,nosuid,nodev(,exec|,noexec)?,size=\d{1,3}m(,mode=1777)?$/,
    'tmpfs options must be rw,nosuid,nodev and sized',
  )
  .refine(
    (value) => Number(/size=(\d+)m/.exec(value)?.[1]) <= 256,
    'a verifier tmpfs is at most 256m',
  );

/** A working directory inside the mounted verify/ folder, without `.` or `..` segments. */
const workingDir = z
  .string()
  .max(1024)
  .regex(/^\/check\/verify(\/[^/\0]+)*$/, 'the working directory is in /check/verify')
  .refine((path) => !/\/\.\.?(\/|$)/.test(path), 'no . or .. segments');

/**
 * The verifier container's create body. Strict at every level, like the
 * trial schema: an unknown field (Binds, CapAdd, Devices, NetworkingConfig,
 * ...) is a refusal.
 */
export function verifierBodySchema(config: { trialImage: string; trialVolume: string }) {
  return z
    .object({
      Image: z.literal(config.trialImage),
      Entrypoint: z.tuple([z.literal(VERIFIER_PYTHON)]),
      Cmd: z.array(z.string().max(4096)).min(1).max(16),
      Env: z.tuple([z.string().regex(/^PATH=[A-Za-z0-9_/:.-]{0,1024}$/, 'only PATH is set')]),
      User: z.literal('10000:10000'),
      WorkingDir: workingDir,
      Hostname: z.literal('verifier').optional(),
      Labels: z
        .object({
          'hermes-evals.role': z.literal('trial'),
          'hermes-evals.kind': z.literal('verifier'),
          'hermes-evals.verifier': z.string().regex(new RegExp(`^${ULID}$`)),
          'hermes-evals.deadline': z.string().regex(/^\d{1,12}$/),
        })
        .strict(),
      AttachStdin: z.literal(false).optional(),
      AttachStdout: z.boolean().optional(),
      AttachStderr: z.boolean().optional(),
      Tty: z.literal(false).optional(),
      OpenStdin: z.literal(false).optional(),
      StdinOnce: z.literal(false).optional(),
      HostConfig: z
        .object({
          ReadonlyRootfs: z.literal(true),
          CapDrop: z.tuple([z.literal('ALL')]),
          SecurityOpt: z.tuple([z.enum(['no-new-privileges', 'no-new-privileges:true'])]),
          Privileged: z.literal(false).optional(),
          Init: z.literal(true),
          AutoRemove: z.literal(false).optional(),
          NetworkMode: z.literal('none'),
          Mounts: z.tuple([
            z
              .object({
                Type: z.literal('volume'),
                Source: z.literal(config.trialVolume),
                Target: z.literal(VERIFIER_MOUNT),
                ReadOnly: z.literal(true),
                VolumeOptions: z
                  .object({
                    NoCopy: z.literal(true).optional(),
                    Subpath: z.string().regex(new RegExp(`^verify-${ULID}$`)),
                  })
                  .strict(),
              })
              .strict(),
          ]),
          Tmpfs: z.object({ '/tmp': tmpfsOptions }).strict(),
          Memory: z
            .number()
            .int()
            .min(64 * MIB)
            .max(2 * GIB),
          MemorySwap: z.number().int(),
          NanoCpus: z.number().int().min(1).max(2_000_000_000),
          PidsLimit: z.number().int().min(1).max(512),
          Ulimits: z
            .array(
              z
                .object({
                  Name: z.literal('nofile'),
                  Soft: z.number().int().min(1).max(4096),
                  Hard: z.number().int().min(1).max(4096),
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
                  'max-size': z.string().regex(/^\d{1,2}m$/),
                  'max-file': z.literal('1').optional(),
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
    })
    .strict();
}

export type VerifierCreateBody = z.infer<ReturnType<typeof verifierBodySchema>>;

/**
 * Checks a verifier body created under the name `hermes-evals-verify-<id>`:
 * the schema above, no swap, and the same id in the name, the label and the
 * mounted subpath, so a container can only read its own scratch folder.
 */
export function checkVerifierBody(
  body: unknown,
  config: { trialImage: string; trialVolume: string },
  id: string,
): { ok: true; body: VerifierCreateBody } | { ok: false; reasons: string[] } {
  const result = verifierBodySchema(config)
    .superRefine((parsed, ctx) => {
      const host = parsed.HostConfig;
      if (host.MemorySwap !== host.Memory) {
        ctx.addIssue({ code: 'custom', message: 'MemorySwap must equal Memory (no swap)' });
      }
      if (parsed.Labels['hermes-evals.verifier'] !== id) {
        ctx.addIssue({
          code: 'custom',
          message: 'label hermes-evals.verifier must be the id in the container name',
        });
      }
      if (host.Mounts[0].VolumeOptions.Subpath !== `verify-${id}`) {
        ctx.addIssue({
          code: 'custom',
          message: 'a verifier may only mount its own verify-<id> directory',
        });
      }
    })
    .safeParse(body);
  if (result.success) return { ok: true, body: result.data };
  return {
    ok: false,
    reasons: result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
    ),
  };
}
