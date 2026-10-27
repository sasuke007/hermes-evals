/**
 * What the repository's samples/ declares, for the Phase 8 e2e
 * (test/phase8.e2e-spec.ts): read from the files themselves, not through the
 * seed's own code (apps/api/src/samples), so the e2e checks the seed against
 * the folders and samples/configurations.yaml rather than against itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import {
  SAMPLE_CONFIGURATION_FAMILIES,
  sampleConfigurationName,
  type SeedItem,
} from '@hermes-evals/shared';

export const SAMPLES = join(import.meta.dirname, '..', '..', '..', '..', 'samples');

const dirs = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
const files = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

/** Each skill folder's name, as its SKILL.md front matter gives it. */
export const SKILLS = dirs(join(SAMPLES, 'skills')).map((dir) => {
  const skillMd = readFileSync(join(SAMPLES, 'skills', dir, 'SKILL.md'), 'utf8');
  return /^name:\s*(\S+)\s*$/m.exec(skillMd)![1]!;
});
/** Every document, as `<suite>/<file>`. */
export const DOCUMENTS = dirs(join(SAMPLES, 'documents')).flatMap((suite) =>
  files(join(SAMPLES, 'documents', suite)).map((file) => `${suite}/${file}`),
);
export const MCP_SERVERS = ['invoice-db', 'vendor-directory'];

interface Limits {
  max_turns: number;
  time_budget_s: number;
}
interface Family extends Limits {
  provider: string;
  model: string;
  base_url?: string;
}
interface Arm {
  toolsets: string[];
  memory?: boolean;
  skills?: string[];
  skill_loading?: 'preload' | 'on_demand';
  documents?: string[];
  mcp_servers?: string[];
  limits?: Partial<Record<'real' | 'mock', Limits>>;
}
const DECLARED = parse(readFileSync(join(SAMPLES, 'configurations.yaml'), 'utf8')) as {
  families: Record<'real' | 'mock', Family>;
  suites: Record<string, Record<string, Arm>>;
};

/** Every configuration the file declares, with the settings it should be saved with. */
export const CONFIGURATIONS = SAMPLE_CONFIGURATION_FAMILIES.flatMap((family) =>
  Object.entries(DECLARED.suites).flatMap(([suite, arms]) =>
    Object.entries(arms).map(([arm, spec]) => {
      const base = DECLARED.families[family];
      const limits = spec.limits?.[family] ?? base;
      const skills = spec.skills ?? [];
      return {
        name: sampleConfigurationName(suite, arm, family),
        provider: base.provider,
        model: base.model,
        baseUrl: base.base_url ?? null,
        toolsets: [...spec.toolsets].sort(),
        memoryEnabled: spec.memory ?? false,
        skills: [...skills].sort(),
        skillLoading: skills.length > 0 ? (spec.skill_loading ?? 'preload') : 'preload',
        documents: (spec.documents ?? []).map((d) => basename(d)).sort(),
        mcpServers: [...(spec.mcp_servers ?? [])].sort(),
        maxTurns: limits.max_turns,
        timeBudgetS: limits.time_budget_s,
      };
    }),
  ),
);

export const EXPECTED_ITEMS = [
  ...SKILLS.map((name) => ({ kind: 'skill', name })),
  ...DOCUMENTS.map((name) => ({ kind: 'document', name })),
  ...MCP_SERVERS.map((name) => ({ kind: 'mcp_server', name })),
  ...CONFIGURATIONS.map(({ name }) => ({ kind: 'configuration', name })),
];
export const sortItems = <T extends { kind: string; name: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => `${a.kind} ${a.name}`.localeCompare(`${b.kind} ${b.name}`));
export const kindAndName = (items: SeedItem[]) =>
  sortItems(items.map(({ kind, name }) => ({ kind, name })));
