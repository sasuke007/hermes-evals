/**
 * A suite .zip read as the draft of a new suite (SA.10): readSuiteZip's
 * body (parsers.ts holds the contract).
 *
 * In order, so that a zip a reload would refuse stores nothing:
 * 1. the central directory is checked (zip-entries.ts);
 * 2. the suite folder is found: suite.yaml at the root, or in one folder
 *    that holds everything, which is stripped;
 * 3. suite.yaml, the task folder names and every task.yaml are read and
 *    parsed with the loader's own rules: a failure here is a failure of the
 *    whole directory on a reload (plan 4.4), so the zip is refused with the
 *    loader's message, file and line;
 * 4. every file of the suite streams into the blob store;
 * 5. each task folder is analysed as the loader would read it from disk
 *    (analyseTask on the stored files, through the drafts module's walk
 *    view, folderReader), which classifies its files and gives the
 *    self-check plan; a suite whose self-checks could outlast one load is
 *    refused as a reload would refuse it.
 *
 * The draft holds task.yaml, prompt.md, reference.json and rubrics as text,
 * verbatim (a byte-order mark included), and every other file by blob with
 * the kind the loader gives it. A root file that is not UTF-8 text is kept
 * as a blob of kind `other`, so the save writes the same bytes. Files at the
 * suite root other than suite.yaml (a README) are not part of any task and
 * are left out. No script runs: verify/ files are only listed (R7).
 */
import {
  DIRECTORY_KEY_MESSAGE,
  DIRECTORY_KEY_PATTERN,
  isHomeSeedPath,
  isVerifyPath,
  type DraftFileKind,
  type SuiteZipScript,
  type UploadProblem,
} from '@hermes-evals/shared';
import { MAX_LOAD_SELF_CHECK_SECONDS } from '../../queue/queues.js';
import type { BlobRef, BlobStore } from '../../storage/blob-store.js';
import {
  PROMPT_MD,
  REFERENCE_JSON,
  SELF_CHECK_CONCURRENCY,
  SUITE_YAML,
  TASK_YAML,
} from '../loader/limits.js';
import { parseSuiteYaml } from '../loader/suite-yaml.js';
import { analyseTask } from '../loader/task.js';
import { decodeUtf8 } from '../loader/task-files.js';
import { suiteSelfCheckSeconds, taskSelfCheckSeconds } from '../loader/task-self-check.js';
import { comparePaths } from '../loader/walk.js';
import { parseYamlSource, type LocatedError } from '../loader/yaml-source.js';
import { folderReader } from '../drafts/draft-folder.js';
import type { DraftFileRef, DraftTaskFolder } from '../drafts/materialise.js';
import type { SuiteZipRead } from './parsers.js';
import { cappedProblems } from './task-table.js';
import {
  openSuiteZip,
  shown,
  SUITE_ZIP_LIMITS,
  type SuiteZipLimits,
  type ZipFileEntry,
} from './zip-entries.js';
import { EntryReader, EntryRefused } from './zip-entry-reader.js';

const AGAIN = 'Fix it, then zip the folder again.';

/** Where suite.yaml is: the folder to strip, or why the zip is refused. */
function findSuiteRoot(paths: readonly string[]): { root: string } | UploadProblem {
  if (paths.length === 0) {
    return {
      title: 'The zip is empty.',
      detail: 'Zip the suite folder: suite.yaml and one folder per task.',
    };
  }
  if (paths.includes(SUITE_YAML)) return { root: '' };
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  const [top] = tops;
  if (
    tops.size === 1 &&
    paths.every((p) => p.includes('/')) &&
    paths.includes(`${top}/${SUITE_YAML}`)
  ) {
    return { root: `${top}/` };
  }
  const title = 'No suite.yaml at the zip root.';
  const misnamed = paths.find((p) => /^(?:[^/]+\/)?suite\.ya?ml$/i.test(p));
  if (misnamed) return { title, detail: `Found ${shown(misnamed)}; name it suite.yaml.` };
  const deeper = paths
    .filter((p) => p.endsWith(`/${SUITE_YAML}`))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];
  return {
    title,
    detail: deeper
      ? `Found ${shown(deeper)}, ${deeper.split('/').length - 1} folders down. Zip the suite folder itself.`
      : 'A suite zip holds suite.yaml and one folder per task, at its root or in one folder.',
  };
}

/** A located loader error as a problem: "total_due/task.yaml line 3: …". */
const located = (error: LocatedError, prefix = ''): UploadProblem => ({
  title: `${prefix}${error.file}${error.line !== null ? ` line ${error.line}` : ''}: ${error.message}`,
  detail: AGAIN,
});

/** suite.yaml's problem, with the board's wording for the two keys it must have. */
function suiteYamlProblem(source: string, error: LocatedError): UploadProblem {
  const parsed = parseYamlSource(SUITE_YAML, source);
  const value = parsed.ok ? parsed.value : null;
  const has = (key: string) =>
    typeof value === 'object' && value !== null && Object.hasOwn(value, key);
  if (parsed.ok && !has('version_label')) {
    return {
      title: `${SUITE_YAML}: version_label is required.`,
      detail: 'Add a label such as version_label: "0.1", then zip the folder again.',
    };
  }
  if (parsed.ok && !has('name')) {
    return {
      title: `${SUITE_YAML}: name is required.`,
      detail: 'Add the suite name, such as name: vendor-statements-v1, then zip the folder again.',
    };
  }
  return located(error);
}

/** UTF-8 text exactly as stored, a byte-order mark kept; null for other bytes or a NUL. */
export function verbatimText(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

export interface ReadSuiteZipOptions {
  limits?: SuiteZipLimits;
}

export async function readSuiteZipFile(
  zipPath: string,
  blobs: Pick<BlobStore, 'putStream' | 'read'>,
  options: ReadSuiteZipOptions = {},
): Promise<SuiteZipRead> {
  const limits = options.limits ?? SUITE_ZIP_LIMITS;
  const opened = await openSuiteZip(zipPath, limits);
  if (!opened.ok) {
    return {
      ok: false,
      problems: opened.problems,
      fileCount: 0,
      unpackedBytes: opened.declaredBytes,
    };
  }
  const { zip, listing } = opened;
  const refuse = (problems: UploadProblem[]): SuiteZipRead => ({
    ok: false,
    problems: cappedProblems(problems),
    fileCount: listing.files.length,
    unpackedBytes: listing.declaredBytes,
  });
  try {
    const found = findSuiteRoot(listing.files.map((f) => f.path));
    if (!('root' in found)) return refuse([found]);
    const reader = new EntryReader(zip, limits);
    const { root } = found;

    // Suite-relative paths; files at the root other than suite.yaml belong to no task.
    const byPath = new Map<string, ZipFileEntry>();
    for (const file of listing.files) byPath.set(file.path.slice(root.length), file);
    const taskFolders = new Set<string>();
    for (const path of byPath.keys()) if (path.includes('/')) taskFolders.add(path.split('/')[0]!);
    // An empty folder is a task folder too, as the walk would list it.
    for (const folder of listing.folders) {
      if (folder.startsWith(root) && folder.length > root.length) {
        taskFolders.add(folder.slice(root.length).split('/')[0]!);
      }
    }

    // 3. What fails the whole directory on a reload, before anything is stored.
    const suiteYamlBytes = await reader.read(byPath.get(SUITE_YAML)!);
    // Kept verbatim; parsed as the loader reads it, without a byte-order mark.
    const suiteYaml = verbatimText(suiteYamlBytes);
    const yamlSource = decodeUtf8(suiteYamlBytes);
    if (suiteYaml === null || yamlSource === null) {
      return refuse([
        {
          title: `${SUITE_YAML} is not UTF-8 text.`,
          detail: 'Save it as UTF-8, then zip the folder again.',
        },
      ]);
    }
    const parsed = parseSuiteYaml(yamlSource);
    if (!parsed.ok) return refuse([suiteYamlProblem(yamlSource, parsed.error)]);
    const problems: UploadProblem[] = [];
    for (const folder of [...taskFolders].sort(comparePaths)) {
      if (!DIRECTORY_KEY_PATTERN.test(folder)) {
        problems.push({
          title: `Task folder name ${JSON.stringify(folder)} is not allowed.`,
          detail: `${DIRECTORY_KEY_MESSAGE} Rename the folder, then zip the suite again.`,
        });
      }
    }
    const listed = parsed.suite.tasks ?? [];
    const keys = [
      ...listed,
      ...[...taskFolders].filter((k) => !listed.includes(k)).sort(comparePaths),
    ];
    for (const key of keys) {
      const entry = byPath.get(`${key}/${TASK_YAML}`);
      if (!entry) continue;
      const text = decodeUtf8(await reader.read(entry));
      if (text === null) {
        problems.push({ title: `${key}/${TASK_YAML} is not UTF-8 text.`, detail: AGAIN });
        continue;
      }
      const yaml = parseYamlSource(TASK_YAML, text);
      if (!yaml.ok) problems.push(located(yaml.error, `${key}/`));
    }
    if (problems.length > 0) return refuse(problems);

    // 4. Every file of the tasks into the blob store.
    const stored = new Map<string, Map<string, BlobRef>>(keys.map((k) => [k, new Map()]));
    let unpackedBytes = byPath.get(SUITE_YAML)!.size;
    for (const [path, file] of byPath) {
      const slash = path.indexOf('/');
      if (slash < 0) continue;
      const ref = await reader.store(file, blobs);
      stored.get(path.slice(0, slash))!.set(path.slice(slash + 1), ref);
      unpackedBytes += ref.size;
    }

    // 5. Each task as the loader reads it.
    const tasks: DraftTaskFolder[] = [];
    const scripts: SuiteZipScript[] = [];
    const seconds: number[] = [];
    for (const key of keys) {
      const files = stored.get(key)!;
      // Every file as a blob for now: the walk's view and reader the readiness rules use.
      const asStored: DraftTaskFolder = {
        key,
        taskYaml: null,
        prompt: null,
        reference: null,
        rubrics: {},
        files: [...files].map(([path, ref]) => ({ path, kind: 'other', ...ref })),
      };
      const { entries, read } = folderReader(asStored, (sha256) => blobs.read(sha256));
      const analysis = await analyseTask(key, entries, read);
      if (analysis.yamlError) return refuse([located(analysis.yamlError, `${key}/`)]);
      seconds.push(taskSelfCheckSeconds(analysis));
      const kinds = new Map(analysis.files.map((f) => [f.path, f.kind]));
      tasks.push(await draftTaskOf(key, files, kinds, blobs));
      for (const [path, ref] of files) {
        if (isVerifyPath(path))
          scripts.push({ path: `${key}/${path}`, sizeBytes: ref.size, sha256: ref.sha256 });
      }
    }
    const total = suiteSelfCheckSeconds(seconds, SELF_CHECK_CONCURRENCY);
    if (total > MAX_LOAD_SELF_CHECK_SECONDS) {
      return refuse([
        {
          title: 'The self-checks may take too long.',
          detail: `They may take up to ${total} s, above the ${MAX_LOAD_SELF_CHECK_SECONDS} s one load may take. Lower timeout_s or split the suite, then zip it again.`,
        },
      ]);
    }
    return {
      ok: true,
      contents: {
        suiteYaml,
        suite: {
          name: parsed.suite.name,
          versionLabel: parsed.suite.version_label,
          description: parsed.suite.description ?? null,
        },
        tasks,
        scripts,
        fileCount: 1 + [...stored.values()].reduce((n, files) => n + files.size, 0),
        unpackedBytes,
      },
    };
  } catch (err) {
    if (err instanceof EntryRefused) return refuse([err.problem]);
    throw err;
  } finally {
    zip.close();
  }
}

/** The draft's picture of one task folder: its texts verbatim, every other file by blob and kind. */
async function draftTaskOf(
  key: string,
  files: ReadonlyMap<string, BlobRef>,
  kinds: ReadonlyMap<string, string>,
  blobs: Pick<BlobStore, 'read'>,
): Promise<DraftTaskFolder> {
  const texts: Record<string, string | null> = {
    [TASK_YAML]: null,
    [PROMPT_MD]: null,
    [REFERENCE_JSON]: null,
  };
  const rubrics: Record<string, string> = {};
  const refs: DraftFileRef[] = [];
  for (const [path, ref] of files) {
    const loaderKind = kinds.get(path);
    if (Object.hasOwn(texts, path) || (loaderKind === 'rubric' && !isVerifyPath(path))) {
      const text = verbatimText(await blobs.read(ref.sha256));
      if (text !== null) {
        if (Object.hasOwn(texts, path)) texts[path] = text;
        else rubrics[path] = text;
        continue;
      }
    }
    refs.push({ path, kind: draftKindOf(path, loaderKind), sha256: ref.sha256, size: ref.size });
  }
  return {
    key,
    taskYaml: texts[TASK_YAML] ?? null,
    prompt: texts[PROMPT_MD] ?? null,
    reference: texts[REFERENCE_JSON] ?? null,
    rubrics,
    files: refs.sort((a, b) => comparePaths(a.path, b.path)),
  };
}

/**
 * The draft kind of a blob file. Where a path alone decides the kind
 * (suite_draft_files' checks: verify/, fixtures/, the two seeds) it does,
 * even for a file the walk would not list; otherwise the loader's kind, and
 * `other` for anything the loader does not read.
 */
function draftKindOf(path: string, loaderKind: string | undefined): DraftFileKind {
  if (path.startsWith('verify/')) return 'verifier';
  if (path.startsWith('fixtures/')) return 'fixture';
  if (isHomeSeedPath(path)) return 'home_seed';
  return loaderKind === 'expected' || loaderKind === 'expected_home' ? loaderKind : 'other';
}
