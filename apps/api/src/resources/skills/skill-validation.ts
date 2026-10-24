/**
 * The report POST /resources/skills/validate returns, worded like the
 * ResourceUploadDialog fixtures (apps/web/src/fixtures/resources.ts):
 *
 * - `valid`: a name no stored skill has. Confirm stores it.
 * - `new_version`: the name exists and this version does not. Confirm stores
 *   it next to the others; `existing` is the newest stored version.
 * - `conflict`: this name and version are stored already. With other content
 *   the author must bump the version; with the same content it is simply
 *   "Already uploaded". No token either way.
 * - `invalid`: the zip or SKILL.md has problems. No token.
 */
import type { SkillUploadValidation, UploadCheck, UploadProblem } from '@hermes-evals/shared';
import { countOf, formatBytes } from './format.js';
import type { SkillMetadata } from './front-matter.js';
import type { UnpackResult } from './zip-reader.js';

/** A stored skill with the uploaded name. */
export interface StoredVersion {
  id: string;
  version: string;
  contentHash: string;
  uploadedAt: Date;
}

export interface ValidationFacts {
  /** The zip's name as the browser sent it, already reduced to a base name. */
  fileName: string;
  /** The zip's size in bytes. */
  sizeBytes: number;
  archive: UnpackResult;
  /** SKILL.md's metadata; null when the zip could not be unpacked. */
  metadata: SkillMetadata | null;
  /** Hash of the unpacked tree; null when the zip could not be unpacked. */
  contentHash: string | null;
  /** Stored skills with the uploaded name, any version. */
  stored: StoredVersion[];
  /** The token Confirm would send, used only when the upload can be confirmed. */
  token: string;
}

const fieldCheck = (label: string, field: { value: string | null; ok: boolean }): UploadCheck => ({
  label,
  value: field.value ?? 'missing',
  ok: field.ok,
});

/** Builds the validation report from what the zip, SKILL.md and the skills table said. */
export function buildValidation(facts: ValidationFacts): SkillUploadValidation {
  const { archive, metadata } = facts;
  const base = {
    fileName: facts.fileName,
    sizeBytes: facts.sizeBytes,
    name: null,
    version: null,
    description: null,
    contentHash: null,
    existing: null,
    unpackedBytes: archive.unpackedBytes,
  };
  if (!archive.ok || !metadata || facts.contentHash === null) {
    return {
      ...base,
      token: null,
      outcome: 'invalid',
      checks: [],
      problems: archive.ok ? [] : archive.problems,
      fileTree: archive.ok ? [] : archive.listing,
    };
  }

  const name = metadata.name.value;
  const version = metadata.version.value;
  const sameVersion =
    metadata.problems.length === 0 ? facts.stored.find((s) => s.version === version) : undefined;
  const newest = [...facts.stored].sort(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
  )[0];

  const checks: UploadCheck[] = [
    {
      label: 'SKILL.md',
      value: archive.root === '' ? 'found at zip root' : `found in ${archive.root}`,
      ok: true,
    },
    fieldCheck('name', metadata.name),
    fieldCheck('version', { value: version, ok: metadata.version.ok && !sameVersion }),
    fieldCheck('description', metadata.description),
    {
      label: 'files',
      value: `${countOf(archive.files.length, 'file')} · ${formatBytes(archive.unpackedBytes)} unpacked`,
      ok: true,
    },
    { label: 'content hash', value: `sha256:${facts.contentHash}`, ok: true },
  ];

  const problems: UploadProblem[] = [...metadata.problems];
  let outcome: SkillUploadValidation['outcome'];
  let existing: StoredVersion | undefined;
  if (problems.length > 0) {
    outcome = 'invalid';
  } else if (sameVersion) {
    outcome = 'conflict';
    existing = sameVersion;
    problems.push(
      sameVersion.contentHash === facts.contentHash
        ? {
            title: 'Already uploaded.',
            detail: `${name} ${version} is stored with exactly this content.`,
          }
        : {
            title: `Version ${version} already exists with a different hash.`,
            detail: 'Bump version: in SKILL.md.',
          },
    );
  } else {
    outcome = newest ? 'new_version' : 'valid';
    existing = newest;
  }

  return {
    ...base,
    token: outcome === 'valid' || outcome === 'new_version' ? facts.token : null,
    outcome,
    name,
    version,
    description: metadata.description.value,
    contentHash: facts.contentHash,
    checks,
    problems,
    existing: existing
      ? { id: existing.id, version: existing.version, contentHash: existing.contentHash }
      : null,
    fileTree: archive.files.map((f) => ({ path: f.path, sizeBytes: f.size })),
  };
}
