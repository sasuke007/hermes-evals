/**
 * suite.yaml as a draft writes it (plan 4.6, V5): the live file with only
 * the fields the draft changed patched in through the byte-stable patcher
 * (yaml-patch.ts), or a new file in the canonical style of the sample
 * suites for a new suite (and for a version download, whose suite.yaml the
 * database does not keep). The save (`save-suite-draft`) calls it with the
 * live folder's suite.yaml read under the folder's lock, so an unchanged
 * label, description and order never rewrite the file.
 */
import { parseDocument } from 'yaml';
import { comparePaths } from '../loader/walk.js';
import { patchYaml, renderYaml, sameValue, type PatchOptions } from './yaml-patch.js';

export interface SuiteYamlFields {
  /** suite.yaml's `name`: the folder's name, fixed after the first save. */
  name: string;
  versionLabel: string;
  description: string | null;
  /** Every task the folder will hold, in draft order. */
  tasks: readonly string[];
}

/** The description folded (`>-`) when long, the task list in block style, as the sample suites write them. */
const OPTIONS: PatchOptions = {
  folded: (path) => path.length === 1 && path[0] === 'description',
  block: (path) => path.length === 1 && path[0] === 'tasks',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A scalar's text as suite.yaml's schema reads it (`version_label: 1.0` is "1"); '' for anything else. */
const scalarText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';

/** The order the loader gives tasks a suite.yaml does not list: by folder name. */
const sortedKeys = (keys: readonly string[]): string[] => [...keys].sort(comparePaths);

/**
 * suite.yaml for `fields`: `source` patched where it differs, or a new file
 * when `source` is null or empty. A `tasks` list is written when the file
 * has one, or when the draft order is not the loader's default (folder-name
 * order). Throws YamlPatchError when `source` does not parse.
 */
export function renderSuiteYaml(source: string | null, fields: SuiteYamlFields): string {
  if (source === null || source.trim() === '') {
    const value: Record<string, unknown> = {
      name: fields.name,
      version_label: fields.versionLabel,
    };
    if (fields.description !== null && fields.description !== '') {
      value.description = fields.description;
    }
    value.tasks = [...fields.tasks];
    return renderYaml(value, OPTIONS);
  }
  const raw: unknown = parseDocument(source).toJS();
  const next: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  if (scalarText(next.name) !== fields.name) next.name = fields.name;
  if (scalarText(next.version_label) !== fields.versionLabel) {
    next.version_label = fields.versionLabel;
  }
  const description = typeof next.description === 'string' ? next.description : null;
  if (description !== fields.description) {
    if (fields.description === null || fields.description === '') delete next.description;
    else next.description = fields.description;
  }
  const listed = Array.isArray(next.tasks) ? next.tasks : null;
  if (listed !== null) {
    if (!sameValue(listed, fields.tasks)) next.tasks = [...fields.tasks];
  } else if (!sameValue(sortedKeys(fields.tasks), fields.tasks)) {
    next.tasks = [...fields.tasks];
  }
  return patchYaml(source, next, OPTIONS);
}
