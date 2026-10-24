/**
 * Which secret names MCP definitions reference, and whether the service that
 * reads each one has it (plan 5.3 "Presence", UI_FLOWS 9.4). Pure, so the
 * mapping is tested without a database.
 *
 * - A stdio env name is read by the worker, which sets it in the trial
 *   container's environment: source worker, readable by the agent.
 * - An http header variable is read by egress, which adds the header on the
 *   way to the server: source egress, never in the run.
 * A name used both ways is two rows, because two services must each have it.
 * Presence comes from the names the live worker recorded on its row (its own
 * environment, and egress's as egress reported it). Values never reach here.
 */
import {
  SECRET_EXPOSURE_BY_SOURCE,
  type McpHeader,
  type McpTransport,
  type SecretReference,
  type SecretRow,
  type SecretSource,
} from '@hermes-evals/shared';

/**
 * The parts of a server version that reference secrets. A server can appear
 * more than once, one entry per version still in use.
 */
export interface SecretReferencingServer {
  id: string;
  name: string;
  transport: McpTransport;
  envNames: readonly string[];
  headers: readonly McpHeader[];
}

/** What the live worker reported, or null when no worker is connected. */
export interface WorkerPresence {
  envNames: readonly string[];
  egressEnvNames: readonly string[];
  startedAt: Date;
  lastHeartbeatAt: Date;
}

export const NO_WORKER = 'no worker is connected';

/** When the reported names were last read, as the Secrets page says it. */
export function checkedWhen(worker: WorkerPresence | null): string {
  if (!worker) return NO_WORKER;
  return worker.lastHeartbeatAt.getTime() > worker.startedAt.getTime()
    ? 'on heartbeat'
    : 'at worker start';
}

const SOURCE_ORDER: Record<SecretSource, number> = { worker: 0, egress: 1 };

/**
 * One row per name and source, sorted by name (worker before egress), each
 * listing the servers that reference it. With no worker every row is not set:
 * nothing can vouch for the name, and a test or run would fail for it.
 * `now` is the check time reported when there is no worker heartbeat to show.
 */
export function secretRows(
  servers: readonly SecretReferencingServer[],
  worker: WorkerPresence | null,
  now: Date,
): SecretRow[] {
  const rows = new Map<string, { name: string; source: SecretSource; refs: SecretReference[] }>();
  const add = (name: string, source: SecretSource, ref: SecretReference) => {
    const key = `${source}\u0000${name}`;
    const row = rows.get(key) ?? { name, source, refs: [] };
    // Two versions of one server naming the same variable the same way are one reference.
    const same = (r: SecretReference) =>
      r.id === ref.id && r.via === ref.via && r.header === ref.header;
    if (!row.refs.some(same)) row.refs.push(ref);
    rows.set(key, row);
  };
  for (const s of servers) {
    if (s.transport === 'stdio') {
      for (const env of s.envNames) {
        add(env, 'worker', {
          kind: 'mcp_server',
          id: s.id,
          name: s.name,
          via: 'env',
          header: null,
        });
      }
    } else {
      for (const h of s.headers) {
        add(h.env, 'egress', {
          kind: 'mcp_server',
          id: s.id,
          name: s.name,
          via: 'header',
          header: h.header,
        });
      }
    }
  }
  const has: Record<SecretSource, ReadonlySet<string>> = {
    worker: new Set(worker?.envNames ?? []),
    egress: new Set(worker?.egressEnvNames ?? []),
  };
  const lastCheckedAt = (worker?.lastHeartbeatAt ?? now).toISOString();
  const when = checkedWhen(worker);
  return [...rows.values()]
    .sort((a, b) =>
      a.name === b.name
        ? SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]
        : a.name < b.name
          ? -1
          : 1,
    )
    .map(({ name, source, refs }) => ({
      name,
      set: has[source].has(name),
      source,
      exposure: SECRET_EXPOSURE_BY_SOURCE[source],
      referencedBy: refs.sort((a, b) =>
        a.name === b.name
          ? (a.header ?? '').localeCompare(b.header ?? '')
          : a.name < b.name
            ? -1
            : 1,
      ),
      lastCheckedAt,
      checkedWhen: when,
    }));
}
