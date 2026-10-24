/**
 * SKILL.md front matter: the YAML block between `---` lines at the top of the
 * file, which names the skill (plan 5.1).
 *
 * The split follows Hermes (agent/skill_utils.py parse_frontmatter at the
 * pinned revision): a leading BOM is ignored, the file starts with `---`, and
 * the block ends at the next line that is `---`. The opening line must be
 * exactly `---` here, which is stricter, so every file accepted here reads
 * the same in Hermes.
 *
 * Hermes reads the block as YAML 1.1 (ruamel, hermes_yaml.py) and, when that fails, falls
 * back to splitting `key: value` lines at the first colon. A description such
 * as `Method for invoices: check credit notes` is invalid YAML yet works in
 * Hermes that way, so the same fallback applies here.
 *
 * `name` and `description` must be strings as YAML 1.1 reads them (Hermes's
 * view: `name: 2024` is a number there, `name: yes` a boolean). `version` is
 * taken as written (`1.0` stays "1.0"), because it is our label, not Hermes's.
 */
import type { UploadProblem } from '@hermes-evals/shared';
import { parse } from 'yaml';
import { formatBytes } from './format.js';

export interface SplitSkillMd {
  /** The YAML between the fences, verbatim, without the fence lines. */
  frontMatter: string;
  /** The Markdown after the closing fence, without leading blank lines. */
  body: string;
}

const OPENING = /^---[ \t]*\r?\n/;
const CLOSING = /\n---[ \t\r]*\n/;

/** Splits SKILL.md, or returns null when it has no front matter block. */
export function splitFrontMatter(text: string): SplitSkillMd | null {
  const content = text.replace(/^﻿/, '');
  const opening = OPENING.exec(content);
  if (!opening) return null;
  // Search from the opening newline, so an empty block (`---\n---\n`) closes too.
  const from = opening[0].length - 1;
  const closing = CLOSING.exec(content.slice(from));
  if (!closing) return null;
  return {
    frontMatter: content.slice(opening[0].length, from + closing.index).replace(/\r$/, ''),
    body: content.slice(from + closing.index + closing[0].length).replace(/^(?:[ \t]*\r?\n)+/, ''),
  };
}

/** Skill names as the skills table CHECK accepts them; Hermes preloads skills by this name. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Versions become part of the download file name, so they stay plain. */
export const SKILL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** Hermes truncates longer descriptions (tools/skill_manager_tool.py MAX_DESCRIPTION_LENGTH). */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** One front matter field: its value when present, and whether it is acceptable. */
export interface MetadataField {
  value: string | null;
  ok: boolean;
}

export interface SkillMetadata {
  name: MetadataField;
  version: MetadataField;
  description: MetadataField;
  problems: UploadProblem[];
}

const missing = (key: string): UploadProblem => ({
  title: `No ${key} in metadata.`,
  detail: `Add ${key}: to the SKILL.md front matter.`,
});

const absent: MetadataField = { value: null, ok: false };

/** Hermes's fallback for front matter that is not valid YAML: `key: value` lines, split at the first colon. */
function keyValueLines(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.trim().split('\n')) {
    const colon = line.indexOf(':');
    if (colon >= 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fields;
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Decodes UTF-8 strictly; null when the bytes are not UTF-8. */
function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Hermes reads SKILL.md whole into the agent's context, and the skill viewer
 * shows it as text, so a larger one is refused rather than parsed.
 */
export const MAX_SKILL_MD_BYTES = 1024 * 1024;

const failed = (problem: UploadProblem): SkillMetadata => ({
  name: absent,
  version: absent,
  description: absent,
  problems: [problem],
});

/** The metadata of a SKILL.md over MAX_SKILL_MD_BYTES, which is not read. */
export const skillMdTooLarge = (): SkillMetadata =>
  failed({
    title: 'SKILL.md too large.',
    detail: `It is larger than ${formatBytes(MAX_SKILL_MD_BYTES)}. Move long material into other files of the skill.`,
  });

/** Reads name, version and description from SKILL.md and lists what is wrong. */
export function readSkillMetadata(skillMd: string | Uint8Array): SkillMetadata {
  const size = typeof skillMd === 'string' ? Buffer.byteLength(skillMd) : skillMd.length;
  if (size > MAX_SKILL_MD_BYTES) return skillMdTooLarge();
  const text = typeof skillMd === 'string' ? skillMd : utf8(skillMd);
  if (text === null) {
    return failed({ title: 'SKILL.md is not UTF-8 text.', detail: 'Save SKILL.md as UTF-8.' });
  }
  const split = splitFrontMatter(text);
  if (!split) {
    return failed({
      title: 'No front matter in SKILL.md.',
      detail:
        'Start SKILL.md with a block between --- lines holding name, version and description.',
    });
  }
  let core: unknown;
  let literal: unknown;
  try {
    core = parse(split.frontMatter, { version: '1.1' });
    literal = parse(split.frontMatter, { schema: 'failsafe' });
  } catch {
    core = literal = keyValueLines(split.frontMatter);
  }
  if (!isMapping(core) || !isMapping(literal)) {
    return failed({
      title: 'SKILL.md front matter is not a mapping.',
      detail: 'Write name:, version: and description: as key: value lines.',
    });
  }

  const problems: UploadProblem[] = [];
  /** A field's trimmed text when YAML reads it as a non-empty string. */
  const stringField = (key: string): string | null => {
    const value = core[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };

  let name: MetadataField = absent;
  const rawName = stringField('name');
  if (core.name === undefined || core.name === null || core.name === '') {
    problems.push(missing('name'));
  } else if (rawName === null) {
    const written = typeof literal.name === 'string' ? literal.name.trim() : '(a list or mapping)';
    name = { value: written, ok: false };
    problems.push({
      title: `Name ${written} is not text.`,
      detail: `Quote it in the front matter, for example name: "${written}".`,
    });
  } else if (!SKILL_NAME_PATTERN.test(rawName)) {
    name = { value: rawName, ok: false };
    problems.push({
      title: `Name ${rawName} is not allowed.`,
      detail:
        'Use lowercase letters, digits, - and _ (at most 64 characters), starting with a letter or digit.',
    });
  } else {
    name = { value: rawName, ok: true };
  }

  let version: MetadataField = absent;
  const rawVersion = typeof literal.version === 'string' ? literal.version.trim() : null;
  if (core.version === undefined || core.version === null || rawVersion === '') {
    problems.push(missing('version'));
  } else if (rawVersion === null || !SKILL_VERSION_PATTERN.test(rawVersion)) {
    version = { value: rawVersion, ok: false };
    problems.push({
      title: `Version ${rawVersion ?? '(a list or mapping)'} is not allowed.`,
      detail: 'Use letters, digits, ".", "-", "_" and "+" (at most 64 characters), such as 1.0.0.',
    });
  } else {
    version = { value: rawVersion, ok: true };
  }

  let description: MetadataField = absent;
  const rawDescription = stringField('description');
  if (core.description === undefined || core.description === null || core.description === '') {
    problems.push(missing('description'));
  } else if (rawDescription === null) {
    problems.push({
      title: 'Description is not text.',
      detail: 'Write description: as one line of text, or a quoted or folded string.',
    });
  } else if (rawDescription.length > MAX_DESCRIPTION_LENGTH) {
    description = { value: rawDescription, ok: false };
    problems.push({
      title: 'Description too long.',
      detail: `It has ${rawDescription.length} characters; Hermes reads at most ${MAX_DESCRIPTION_LENGTH}.`,
    });
  } else {
    description = { value: rawDescription, ok: true };
  }

  return { name, version, description, problems };
}
