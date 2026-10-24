/**
 * suite.yaml: parsed and validated with SuiteYamlSchema. Any problem here
 * fails the whole directory (outcome error): without a valid suite.yaml there
 * is no name to serve the suite under, so the last good version stays current.
 */
import { SuiteYamlSchema, type SuiteYaml } from '@hermes-evals/shared';
import { SUITE_YAML } from './limits.js';
import {
  formatPath,
  issueTarget,
  locatedError,
  parseYamlSource,
  positionOf,
  type LocatedError,
} from './yaml-source.js';

export type SuiteYamlParse = { ok: true; suite: SuiteYaml } | { ok: false; error: LocatedError };

export function parseSuiteYaml(source: string): SuiteYamlParse {
  const parsed = parseYamlSource(SUITE_YAML, source);
  if (!parsed.ok) return parsed;
  const result = SuiteYamlSchema.safeParse(parsed.value);
  if (result.success) return { ok: true, suite: result.data };
  // The first issue is enough to fix; the next reload reports the next one.
  const issue = result.error.issues[0]!;
  const target = issueTarget(issue);
  const where = formatPath(target);
  return {
    ok: false,
    error: locatedError(
      SUITE_YAML,
      source,
      positionOf(parsed.doc, parsed.lines, target),
      where ? `${where}: ${issue.message}` : issue.message,
    ),
  };
}

/** Where `name:` is written, for an error about the name (one already taken). */
export function namePosition(source: string): { line: number; column: number } | null {
  const parsed = parseYamlSource(SUITE_YAML, source);
  return parsed.ok ? positionOf(parsed.doc, parsed.lines, ['name']) : null;
}
