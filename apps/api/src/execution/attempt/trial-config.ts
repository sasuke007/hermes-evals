/**
 * The trial's home/config.yaml (plan 8.2): everything Hermes reads that is
 * not a per-run flag, and nothing secret. The attempt runner and the
 * development harness (sandbox/hermes-smoke.ts) both build it here, so the
 * sandbox CLI exercises the same settings experiments run with.
 *
 * What it holds:
 * - the model route, pointed at the egress model gateway. The attempt token
 *   is not in it: Hermes gets that from `--api-key` on the command line.
 * - the toolsets, plus one entry per MCP server name (the `-t` aliases).
 * - memory on or off as the configuration says, for both of Hermes's stores
 *   (MEMORY.md and the user profile), which start empty in a fresh home.
 * - mcp_servers through hermesMcpEntry: stdio env values as `${NAME}`
 *   references Hermes fills from the container environment; http servers at
 *   the egress MCP gateway with an `Authorization: Bearer
 *   ${HERMES_EVALS_ATTEMPT_TOKEN}` reference (providers-map.ts), never a value.
 * - agent.max_turns and agent.run_budget_seconds (`--run-budget` is refused
 *   on the one-shot path).
 * - settings that keep the run from making avoidable network calls or
 *   behaving differently between arms: no update check, no plugin update
 *   check, no curator, no title generation, approvals off, no lazy installs,
 *   no protected instruction files, a gateway daemon that exits 5 s after the
 *   run, and context compression on the main route.
 */
import { stringify } from 'yaml';
import type { McpServerInput } from '@hermes-evals/shared';
import { hermesMcpEntry } from '../../resources/mcp/hermes-config.js';
import type { AttemptPlan } from '../contracts.js';
import { hermesModelConfig } from '../providers-map.js';

/** Where Hermes reads its configuration, inside the trial. */
export const TRIAL_CONFIG_PATH = '/opt/data/config.yaml';

export interface HermesConfigInput {
  /** config.yaml's `model` section (hermesModelConfig, or the harness's own route). */
  model: { default: string; provider: string; base_url: string; context_length: number };
  /** The `-t` list: the configured toolsets, then the MCP server names. */
  toolsets: readonly string[];
  memoryEnabled: boolean;
  maxTurns: number;
  runBudgetSeconds: number;
  mcpServers: readonly McpServerInput[];
}

/**
 * One MCP server's config.yaml entry: hermesMcpEntry, the same builder the
 * MCP "Test start" uses, so a test checks what a run gets. An http entry
 * carries the gateway's bearer reference, which Hermes interpolates from the
 * container environment and sends on every request, its preflight included.
 */
export function mcpServerEntry(definition: McpServerInput): Record<string, unknown> {
  return hermesMcpEntry(definition);
}

/** The configured toolsets followed by each MCP server name, without repeats. */
export function trialToolsets(
  toolsets: readonly string[],
  mcpServerNames: readonly string[],
): string[] {
  return [...new Set([...toolsets, ...mcpServerNames])];
}

export function hermesConfig(input: HermesConfigInput): Record<string, unknown> {
  return {
    model: { ...input.model },
    toolsets: [...input.toolsets],
    memory: { memory_enabled: input.memoryEnabled, user_profile_enabled: input.memoryEnabled },
    mcp_servers: Object.fromEntries(input.mcpServers.map((def) => [def.name, mcpServerEntry(def)])),
    agent: { max_turns: input.maxTurns, run_budget_seconds: input.runBudgetSeconds },
    approvals: { mode: 'off' },
    updates: { check: false },
    plugins: { auto_update_check_hours: 0 },
    curator: { enabled: false },
    auxiliary: {
      title_generation: { enabled: false },
      // `auto` with no model or base URL inherits the main route: the gateway,
      // the attempt token from the command line and the configured model, the
      // only route egress serves this attempt. A base URL here without a key
      // would make Hermes look for one in the environment instead
      // (agent/auxiliary_client.py _resolve_task_provider_model).
      compression: { provider: 'auto', model: '', base_url: '' },
    },
    security: { allow_lazy_installs: false, protected_instruction_files: false },
    gateway: { unmanaged_idle_exit_seconds: 5 },
  };
}

/** The config of one attempt, from its plan. */
export function attemptConfig(plan: AttemptPlan): Record<string, unknown> {
  const { configuration, limits } = plan;
  return hermesConfig({
    model: hermesModelConfig(configuration.provider, configuration.model),
    toolsets: trialToolsets(
      configuration.toolsets,
      configuration.mcpServers.map((s) => s.name),
    ),
    memoryEnabled: configuration.memoryEnabled,
    maxTurns: limits.maxTurns,
    runBudgetSeconds: limits.runBudgetS,
    mcpServers: configuration.mcpServers.map((s) => s.definition),
  });
}

export const configYaml = (config: Record<string, unknown>): string => stringify(config);

/**
 * The copy of config.yaml the launch record keeps (plan 13): every `${NAME}`
 * reference shown as `<from env NAME>`. The file in the home holds only the
 * references, so this is the same text with nothing resolved.
 */
export const displayConfigYaml = (yaml: string): string =>
  yaml.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '<from env $1>');
