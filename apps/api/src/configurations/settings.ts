/**
 * Pure rules of configuration versions (plan section 6): how a saved form
 * becomes stored settings, the config hash, the display values the diff
 * table compares, and the history line each version carries. No database
 * here, so every rule is unit-tested on its own (settings.spec.ts).
 */
import { createHash } from 'node:crypto';
import {
  CONFIG_FIELDS,
  type ConfigDiff,
  type ConfigDiffRow,
  type ConfigField,
  type ConfigVersionRef,
  type DocumentRef,
  type McpServerRef,
  type Provider,
  SKILL_LOADING_LABELS,
  type SkillLoadingMode,
  type SkillRef,
} from '@hermes-evals/shared';
import { canonicalJson } from '../queue/queues.js';

/** An MCP definition a version uses, with the hash that feeds the config hash. */
export interface ResolvedMcpServer extends McpServerRef {
  definitionHash: string;
}

/**
 * What a configuration version runs with, its id lists resolved to the rows
 * they name. Every list is in canonical order (see orderSettings), so two
 * versions with the same settings compare and hash the same whatever order
 * the form sent them in.
 */
export interface ResolvedSettings {
  model: string;
  provider: Provider;
  baseUrl: string | null;
  toolsets: string[];
  memoryEnabled: boolean;
  skills: SkillRef[];
  /** How the skills reach the agent (Phase 6 P5); always `preload` without skills. */
  skillLoading: SkillLoadingMode;
  documents: DocumentRef[];
  mcpServers: ResolvedMcpServer[];
  maxTurns: number;
  timeBudgetS: number;
}

/** Version of the config hash payload; bump it if the payload ever changes shape. */
const HASH_FORMAT = 1;

/** Code-point comparison: deterministic, unlike localeCompare, which depends on the ICU build. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Toolsets as stored: sorted and de-duplicated. MCP server names are appended at launch, not here. */
export const normaliseToolsets = (toolsets: readonly string[]): string[] =>
  [...new Set(toolsets)].sort(byText);

/**
 * Puts every list in its canonical order: toolsets sorted, skills by name and
 * version, documents by filename, MCP servers by name, each with the id as a
 * tie-break. The form offers checkboxes, so the order a user picked them in
 * carries no meaning; Hermes loads them by name either way.
 */
export function orderSettings(s: ResolvedSettings): ResolvedSettings {
  return {
    ...s,
    toolsets: normaliseToolsets(s.toolsets),
    skills: [...s.skills].sort(
      (a, b) =>
        byText(a.name, b.name) || byText(a.version, b.version) || byText(a.skillId, b.skillId),
    ),
    documents: [...s.documents].sort(
      (a, b) => byText(a.filename, b.filename) || byText(a.documentId, b.documentId),
    ),
    mcpServers: [...s.mcpServers].sort(
      (a, b) => byText(a.name, b.name) || byText(a.versionId, b.versionId),
    ),
  };
}

/**
 * sha256 of the normalised settings plus the content of every resource they
 * reference: skill content hashes, document sha256s and MCP definition
 * hashes. The configuration's name is left out, so a renamed or duplicated
 * configuration with the same fields has the same hash, and estimates built
 * from past attempts still match it (plan 7.2). Ids are left out for the
 * same reason: a re-uploaded identical document is the same input.
 *
 * Skill loading (Phase 6 P5) enters the payload only when it is `on_demand`.
 * Every version stored before it preloaded, so a `preload` version hashes
 * exactly as it did, its stored hash stays true, and the estimates of the
 * attempts it ran still match it; HASH_FORMAT stays 1 for the same reason.
 */
export function configHash(settings: ResolvedSettings): string {
  const s = orderSettings(settings);
  const payload = {
    format: HASH_FORMAT,
    model: s.model,
    provider: s.provider,
    baseUrl: s.baseUrl,
    toolsets: s.toolsets,
    memoryEnabled: s.memoryEnabled,
    maxTurns: s.maxTurns,
    timeBudgetS: s.timeBudgetS,
    // The name is part of what the agent sees: `-s <name>` and home/skills/<name>/.
    skills: s.skills.map((k) => ({ name: k.name, version: k.version, contentHash: k.contentHash })),
    // So is the filename: workspace/docs/<filename>.
    documents: s.documents.map((d) => ({ filename: d.filename, sha256: d.sha256 })),
    // And the server name, which becomes its `-t` toolset alias.
    mcpServers: s.mcpServers.map((m) => ({ name: m.name, definitionHash: m.definitionHash })),
    // No -s and the skills toolset: the agent sees a different prompt and tool list.
    ...(s.skillLoading === 'on_demand' ? { skillLoading: s.skillLoading } : {}),
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** True when two versions run with the same settings and the same resource rows. */
export function sameSettings(a: ResolvedSettings, b: ResolvedSettings): boolean {
  const key = (s: ResolvedSettings) => {
    const o = orderSettings(s);
    return canonicalJson({
      model: o.model,
      provider: o.provider,
      baseUrl: o.baseUrl,
      toolsets: o.toolsets,
      memoryEnabled: o.memoryEnabled,
      maxTurns: o.maxTurns,
      timeBudgetS: o.timeBudgetS,
      skills: o.skills.map((k) => k.skillId),
      skillLoading: o.skillLoading,
      documents: o.documents.map((d) => d.documentId),
      mcpServers: o.mcpServers.map((m) => m.versionId),
    });
  };
  return key(a) === key(b);
}

// ---------------------------------------------------------------------------
// Display values and the diff table
// ---------------------------------------------------------------------------

const NONE = '—';

const skillLabel = (s: SkillRef) => `${s.name}@${s.version}`;

/**
 * Display value of one field, as ConfigDiffTable shows it: "file, terminal",
 * "off", "—", "invoice-method@1.0.0", "on demand", "invoice-db (stdio)". The
 * provider carries the base URL for `custom`, so two custom providers that
 * differ only in where they point still show as different.
 */
export function fieldValue(name: string, s: ResolvedSettings, field: ConfigField): string {
  switch (field) {
    case 'name':
      return name;
    case 'model':
      return s.model;
    case 'provider':
      return s.baseUrl === null ? s.provider : `${s.provider} (${s.baseUrl})`;
    case 'toolsets':
      return s.toolsets.join(', ') || NONE;
    case 'memory':
      return s.memoryEnabled ? 'on' : 'off';
    case 'skills':
      return s.skills.map(skillLabel).join(', ') || NONE;
    case 'skill_loading':
      return SKILL_LOADING_LABELS[s.skillLoading];
    case 'documents':
      return s.documents.map((d) => d.filename).join(', ') || NONE;
    case 'mcp_servers':
      return s.mcpServers.map((m) => `${m.name} (${m.transport})`).join(', ') || NONE;
    case 'max_turns':
      return String(s.maxTurns);
    case 'time_budget_s':
      return String(s.timeBudgetS);
  }
}

/** One column of a diff: the version it shows, under its configuration's current name. */
export interface DiffColumn {
  ref: ConfigVersionRef;
  settings: ResolvedSettings;
}

/**
 * ConfigDiffTable data: one row per field in CONFIG_FIELDS order, `name`
 * first and never counted as a difference. The first column is the reference
 * the others are read against, but a field differs when any two columns do.
 */
export function configDiff(columns: readonly DiffColumn[]): ConfigDiff {
  const ordered = columns.map((c) => ({ ...c, settings: orderSettings(c.settings) }));
  const rows: ConfigDiffRow[] = CONFIG_FIELDS.map((field) => {
    const values = ordered.map((c) => fieldValue(c.ref.name, c.settings, field));
    const differs = field !== 'name' && values.some((v) => v !== values[0]);
    return { field, values, differs };
  });
  return {
    columns: ordered.map((c) => c.ref),
    rows,
    differing: rows.filter((r) => r.differs).map((r) => r.field),
  };
}

const PLACEHOLDER_REF: ConfigVersionRef = {
  configurationId: '',
  versionId: '',
  name: '',
  version: 1,
};

/** Fields whose display value differs between two versions, in CONFIG_FIELDS order (never `name`). */
export const differingFields = (a: ResolvedSettings, b: ResolvedSettings): ConfigField[] =>
  configDiff([
    { ref: PLACEHOLDER_REF, settings: a },
    { ref: PLACEHOLDER_REF, settings: b },
  ]).differing;

// ---------------------------------------------------------------------------
// History lines
// ---------------------------------------------------------------------------

/** "added skill a@1.0.0" or "added skills a@1.0.0, b@2.0.0". */
const listed = (verb: string, singular: string, plural: string, items: readonly string[]) =>
  `${verb} ${items.length === 1 ? singular : plural} ${items.join(', ')}`;

interface Keyed {
  id: string;
  /** What two entries share when one replaced the other (skill name, filename, server). */
  slot: string;
  label: string;
  /** The line for this entry when it replaced another in its slot: "updated MCP server invoice-db to v2". */
  replaced: string;
}

const NOUNS = {
  skill: { singular: 'skill', plural: 'skills' },
  document: { singular: 'document', plural: 'documents' },
  mcp: { singular: 'MCP server', plural: 'MCP servers' },
} as const;

/**
 * Adds, removals and replacements between two lists of resources. An entry
 * whose slot (skill name, document filename, MCP server) is in both lists
 * with a different id was replaced, which reads better as "updated skill
 * invoice-method to 1.1.0" than as an add plus a remove.
 */
function resourceChanges(
  prev: readonly Keyed[],
  next: readonly Keyed[],
  noun: { singular: string; plural: string },
): string[] {
  const prevIds = new Set(prev.map((e) => e.id));
  const nextIds = new Set(next.map((e) => e.id));
  const added = next.filter((e) => !prevIds.has(e.id));
  const removed = prev.filter((e) => !nextIds.has(e.id));
  const removedSlots = new Set(removed.map((e) => e.slot));
  const replaced = added.filter((e) => removedSlots.has(e.slot));
  const replacedSlots = new Set(replaced.map((e) => e.slot));
  const parts: string[] = [];
  const plainAdded = added.filter((e) => !replacedSlots.has(e.slot)).map((e) => e.label);
  const plainRemoved = removed.filter((e) => !replacedSlots.has(e.slot)).map((e) => e.label);
  if (plainAdded.length > 0) parts.push(listed('added', noun.singular, noun.plural, plainAdded));
  if (plainRemoved.length > 0) {
    parts.push(listed('removed', noun.singular, noun.plural, plainRemoved));
  }
  for (const e of replaced) parts.push(e.replaced);
  return parts;
}

/**
 * What changed from one version to the next, in CONFIG_FIELDS order:
 * "changed model; added skill invoice-method@1.0.0". Scalars say only which
 * field changed; the version itself shows the new value. Resources are named.
 */
export function changeParts(prev: ResolvedSettings, next: ResolvedSettings): string[] {
  const parts: string[] = [];
  if (prev.model !== next.model) parts.push('changed model');
  if (prev.provider !== next.provider) parts.push('changed provider');
  else if (prev.baseUrl !== next.baseUrl) parts.push('changed base URL');

  const prevTools = new Set(prev.toolsets);
  const nextTools = new Set(next.toolsets);
  const toolsAdded = normaliseToolsets(next.toolsets.filter((t) => !prevTools.has(t)));
  const toolsRemoved = normaliseToolsets(prev.toolsets.filter((t) => !nextTools.has(t)));
  if (toolsAdded.length > 0) parts.push(listed('added', 'toolset', 'toolsets', toolsAdded));
  if (toolsRemoved.length > 0) parts.push(listed('removed', 'toolset', 'toolsets', toolsRemoved));

  if (prev.memoryEnabled !== next.memoryEnabled) {
    parts.push(next.memoryEnabled ? 'turned memory on' : 'turned memory off');
  }

  const skill = (s: SkillRef): Keyed => ({
    id: s.skillId,
    slot: s.name,
    label: skillLabel(s),
    replaced: `updated skill ${s.name} to ${s.version}`,
  });
  const doc = (d: DocumentRef): Keyed => ({
    id: d.documentId,
    slot: d.filename,
    label: d.filename,
    replaced: `replaced document ${d.filename}`,
  });
  const mcp = (m: McpServerRef): Keyed => ({
    id: m.versionId,
    slot: m.name,
    label: m.name,
    replaced: `updated MCP server ${m.name} to v${m.version}`,
  });
  const a = orderSettings(prev);
  const b = orderSettings(next);
  parts.push(...resourceChanges(a.skills.map(skill), b.skills.map(skill), NOUNS.skill));
  if (prev.skillLoading !== next.skillLoading) {
    parts.push(`set skill loading to ${SKILL_LOADING_LABELS[next.skillLoading]}`);
  }
  parts.push(...resourceChanges(a.documents.map(doc), b.documents.map(doc), NOUNS.document));
  parts.push(...resourceChanges(a.mcpServers.map(mcp), b.mcpServers.map(mcp), NOUNS.mcp));

  if (prev.maxTurns !== next.maxTurns) parts.push('changed max turns');
  if (prev.timeBudgetS !== next.timeBudgetS) parts.push('changed time budget');
  return parts;
}

/** Where a version came from, which decides what its history line compares against. */
export type VersionOrigin =
  | { kind: 'created' }
  | { kind: 'duplicated'; source: ConfigVersionRef; settings: ResolvedSettings }
  | { kind: 'next'; previous: ResolvedSettings };

/**
 * The history line of a version: "Created"; "Duplicated from baseline v1;
 * added skill invoice-method@1.0.0"; or, for version n > 1, what changed
 * from version n - 1. An in-place edit recomputes it the same way, so the
 * line always describes the version as it now is.
 */
export function changeNote(origin: VersionOrigin, settings: ResolvedSettings): string {
  switch (origin.kind) {
    case 'created':
      return 'Created';
    case 'duplicated': {
      const head = `Duplicated from ${origin.source.name} v${origin.source.version}`;
      const parts = changeParts(origin.settings, settings);
      return parts.length > 0 ? `${head}; ${parts.join('; ')}` : head;
    }
    case 'next': {
      const parts = changeParts(origin.previous, settings);
      return parts.length > 0 ? parts.join('; ') : 'No setting changes';
    }
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Longest configuration name the slug rule allows. */
const MAX_NAME = 63;

/**
 * "<name>-copy", or "<name>-copy-2", "-copy-3", ... when taken, shortened so
 * the result still fits the 63-character slug rule.
 */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? '-copy' : `-copy-${n}`;
    const candidate = `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
