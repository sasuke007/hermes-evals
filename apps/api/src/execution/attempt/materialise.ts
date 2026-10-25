/**
 * Builds an attempt's home and workspace (plan 5.4) in the fresh directories
 * prepareTrialDirs made. Only three things from the platform ever enter them:
 * the task's fixtures and the configuration's documents (workspace), and the
 * configuration's skills (home), plus the files Hermes needs (task.txt,
 * config.yaml, .no-bundled-skills, .run). Nothing else of the task — the
 * reference answer, verifiers, rubric, expected workspace — is read here.
 *
 * Every copy re-checks the content it wrote against the hash it was promised,
 * opens its source with O_NOFOLLOW, never follows a link, and creates its
 * target with O_EXCL, so nothing is ever written through something that was
 * already there. A broken promise ends the attempt as `setup`.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LaunchRecord } from '@hermes-evals/shared';
import { SKILL_NAME_PATTERN } from '../../resources/skills/front-matter.js';
import { skillContentHash } from '../../resources/skills/skill-files.js';
import { walkTrialTree } from '../../sandbox/trial-files.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { AttemptPlan } from '../contracts.js';
import { AttemptSetupError } from './errors.js';

export interface MaterialiseDeps {
  blobs: BlobStore;
  /** DATA_DIR/skills: stored skill trees, one directory per content hash. */
  skillsDir: string;
}

/** A file copied into the workspace before the run, for labelling artifacts (plan 8.5). */
export interface InputFile {
  source: 'fixture' | 'document';
  sha256: string;
  size: number;
}

export interface MaterialisedTrial {
  /** The launch record's `inputs`. */
  inputs: LaunchRecord['inputs'];
  /** Workspace-relative path to the input copied there. */
  manifest: Map<string, InputFile>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const COPY_CHUNK = 1024 * 1024;

const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? 'error';

/** The segments of a workspace-relative path, or a setup error for anything that could escape. */
function segmentsOf(path: string, what: string): string[] {
  const segments = path.split('/');
  if (
    path === '' ||
    path.includes('\0') ||
    segments.some((s) => s === '' || s === '.' || s === '..')
  ) {
    throw new AttemptSetupError(
      `${what} has a path that is not a plain relative path: ${JSON.stringify(path)}`,
    );
  }
  return segments;
}

/** Creates each missing parent directory of `segments` under `base`; an existing one must be a real directory. */
async function ensureParents(base: string, segments: readonly string[]): Promise<void> {
  let dir = base;
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    try {
      await mkdir(dir, { mode: 0o755 });
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
      const stat = await lstat(dir);
      if (!stat.isDirectory()) {
        throw new AttemptSetupError(`${dir} exists and is not a directory`);
      }
    }
  }
}

/**
 * Copies one regular file to a target that must not exist, hashing what it
 * writes. The source is opened without following a final link and checked
 * to be a regular file; the target is created exclusively, never followed.
 */
async function copyHashed(
  source: string,
  target: string,
): Promise<{ sha256: string; size: number }> {
  const src = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await src.stat()).isFile())
      throw new AttemptSetupError(`${source} is not a regular file`);
    const dst = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(COPY_CHUNK);
      let size = 0;
      for (;;) {
        const { bytesRead } = await src.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        for (let at = 0; at < bytesRead;) {
          at += (await dst.write(buffer, at, bytesRead - at)).bytesWritten;
        }
        size += bytesRead;
      }
      return { sha256: hash.digest('hex'), size };
    } finally {
      await dst.close();
    }
  } finally {
    await src.close();
  }
}

/** Copies a blob to `rel` in the workspace and checks the copy is the content promised. */
async function placeBlob(
  deps: MaterialiseDeps,
  workspace: string,
  rel: string,
  expected: { sha256: string; size?: number },
  what: string,
): Promise<number> {
  const segments = segmentsOf(rel, what);
  await ensureParents(workspace, segments);
  let copied;
  try {
    copied = await copyHashed(deps.blobs.path(expected.sha256), join(workspace, ...segments));
  } catch (err) {
    if (err instanceof AttemptSetupError) throw err;
    const code = errorCode(err);
    throw new AttemptSetupError(
      code === 'EEXIST'
        ? `${what} would overwrite ${rel}, which another input already placed there`
        : `${what} could not be copied from the blob store (${code})`,
    );
  }
  if (
    copied.sha256 !== expected.sha256 ||
    (expected.size !== undefined && copied.size !== expected.size)
  ) {
    throw new AttemptSetupError(
      `${what} does not match its recorded hash: the blob store copy has changed`,
    );
  }
  return copied.size;
}

/** Copies a stored skill tree to home/skills/<name>/ and checks it hashes to the version's content hash. */
async function placeSkill(
  deps: MaterialiseDeps,
  skillsHome: string,
  skill: AttemptPlan['configuration']['skills'][number],
): Promise<void> {
  const what = `skill ${skill.name} ${skill.version}`;
  if (!SHA256.test(skill.contentHash))
    throw new AttemptSetupError(`${what} has no valid content hash`);
  // The skills table's own rule, so the name is one plain path segment.
  if (!SKILL_NAME_PATTERN.test(skill.name))
    throw new AttemptSetupError(`${what} has an invalid name`);
  const source = join(deps.skillsDir, skill.contentHash);
  const stat = await lstat(source).catch(() => null);
  if (!stat?.isDirectory()) throw new AttemptSetupError(`${what} is missing from the skill store`);
  const tree = await walkTrialTree(source);
  const odd = tree.entries.find((e) => e.kind !== 'file' && !(e.kind === 'dir' && e.entered));
  if (tree.truncated || odd) {
    throw new AttemptSetupError(
      `${what} holds something other than folders and files${odd ? `: ${odd.path}` : ''}`,
    );
  }
  const target = join(skillsHome, skill.name);
  try {
    await mkdir(target, { mode: 0o755 });
  } catch (err) {
    throw new AttemptSetupError(
      `${what} cannot be placed: ${errorCode(err)} (two skills with one name?)`,
    );
  }
  const files: Array<{ path: string; sha256: string }> = [];
  for (const entry of tree.entries) {
    const segments = entry.path.split('/');
    if (entry.kind === 'dir') {
      await mkdir(join(target, ...segments), { mode: 0o755 });
    } else {
      await ensureParents(target, segments);
      const copied = await copyHashed(join(source, ...segments), join(target, ...segments));
      files.push({ path: entry.path, sha256: copied.sha256 });
    }
  }
  if (skillContentHash(files) !== skill.contentHash) {
    throw new AttemptSetupError(
      `${what} does not match its content hash: the stored tree has changed`,
    );
  }
}

/**
 * Fills the attempt's fresh home and workspace. `configYaml` is the text of
 * home/config.yaml (trial-config.ts); it holds references, never values.
 */
export async function materialiseTrial(
  plan: AttemptPlan,
  configYaml: string,
  deps: MaterialiseDeps,
): Promise<MaterialisedTrial> {
  const { home, workspace } = plan.paths;
  const inputs: LaunchRecord['inputs'] = [];
  const manifest = new Map<string, InputFile>();

  for (const fixture of plan.task.fixtures) {
    const what = `fixture ${fixture.path}`;
    const size = await placeBlob(deps, workspace, fixture.path, fixture, what);
    inputs.push({ path: fixture.path, sha256: fixture.sha256, source: 'fixture' });
    manifest.set(fixture.path, { source: 'fixture', sha256: fixture.sha256, size });
  }
  for (const doc of plan.configuration.documents) {
    const what = `document ${doc.filename}`;
    if (doc.filename.includes('/') || doc.filename.includes('\\')) {
      throw new AttemptSetupError(`${what} has a file name with a path separator`);
    }
    const path = `docs/${doc.filename}`;
    const size = await placeBlob(deps, workspace, path, doc, what);
    inputs.push({ path, sha256: doc.sha256, source: 'document', document_id: doc.id });
    manifest.set(path, { source: 'document', sha256: doc.sha256, size });
  }

  if (plan.configuration.skills.length > 0) {
    const skillsHome = join(home, 'skills');
    await mkdir(skillsHome, { mode: 0o755 });
    for (const skill of plan.configuration.skills) await placeSkill(deps, skillsHome, skill);
  }
  // Hermes's own runtime directory and its switch-off for the 58 bundled skills (plan 5.4).
  await mkdir(join(home, '.run'), { mode: 0o700 });
  await writeFile(join(home, '.no-bundled-skills'), '', { flag: 'wx' });
  await writeFile(join(home, 'task.txt'), plan.task.prompt, { flag: 'wx' });
  await writeFile(join(home, 'config.yaml'), configYaml, { flag: 'wx' });
  return { inputs, manifest };
}
