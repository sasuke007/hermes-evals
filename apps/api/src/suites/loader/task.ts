/**
 * One task folder, from its files to everything the loader stores about it
 * except the self-check (plan 4.2): parsed task.yaml, prompt, reference,
 * issues, files by kind and the task's own content hash. Reads go through a
 * TaskReader, so this runs on an in-memory folder in unit tests.
 *
 * A task with an error issue is stored invalid with its issues and gets no
 * self-check plan; it never fails the suite on its own. The one exception is
 * a task.yaml that is not UTF-8 or that YAML cannot parse (plan 4.4: a parse
 * failure keeps the last good version): yamlError carries it, and the
 * directory read (read-suite.ts) fails the whole load with it.
 */
import {
  JsonValueSchema,
  TASK_HOME_DIR,
  TaskLimitsSchema,
  type JsonValue,
  type LoadIssue,
  type TaskLimits,
  type VerificationEntry,
} from '@hermes-evals/shared';
import { fileCheckRootOf } from '../../scoring/registry.js';
import type { SelfCheckEntry } from '../../scoring/self-check.js';
import { contentHash, type HashedFile } from './hashing.js';
import { homeSeedIssues } from './home-seeds.js';
import {
  FIXTURES_DIR,
  MAX_SUITE_FILE_BYTES,
  PROMPT_MD,
  REFERENCE_JSON,
  TASK_YAML,
  VERIFY_DIR,
} from './limits.js';
import {
  collectTaskFiles,
  decodeUtf8,
  normaliseRelative,
  verbatimUtf8,
  under,
  type FileLayout,
  type StoredTaskFile,
  type TaskReader,
} from './task-files.js';
import { fileLayout } from './task-layout.js';
import { checkTaskYaml, type TaskYamlCheck } from './task-yaml.js';
import { comparePaths, type SuiteEntry } from './walk.js';
import { locatedError, parseYamlSource, type LocatedError } from './yaml-source.js';

/** What the self-check needs; present only when the task has no load error. */
export interface SelfCheckPlan {
  entries: SelfCheckEntry[];
  reference: JsonValue;
  /** Normalised folder overlaid on the fixtures, or null. */
  expectedDir: string | null;
  /** Normalised folder overlaid on the home seeds (`self_check.expected_home`), or null. */
  expectedHomeDir: string | null;
  negativeControl: boolean;
}

/**
 * task.yaml, prompt.md or reference.json as read: what task_root_files keeps
 * (Phase 5b), so a task diff can show their sizes and hashes and a draft of
 * the task starts from the exact bytes.
 */
export interface RootFileRead {
  path: string;
  sha256: string;
  size: number;
  /** The text when the bytes are UTF-8 (a byte-order mark kept) without NUL; null otherwise. */
  text: string | null;
}

export interface AnalysedTask {
  key: string;
  summary: string | null;
  prompt: string | null;
  /** task.yaml as read, when it is UTF-8. */
  taskYaml: string | null;
  limits: TaskLimits | null;
  /** undefined when reference.json is missing or invalid (stored as SQL NULL). */
  reference: JsonValue | undefined;
  verification: VerificationEntry[];
  issues: LoadIssue[];
  /** Files stored as task_files, sorted by path. */
  files: StoredTaskFile[];
  /** task.yaml, prompt.md, reference.json (when read) and every stored file, relative to the folder. */
  hashedFiles: HashedFile[];
  /** contentHash(hashedFiles). */
  contentHash: string;
  /** The root files read, by path order (RootFileRead). */
  rootFiles: RootFileRead[];
  plan: SelfCheckPlan | null;
  /**
   * task.yaml was not UTF-8 or did not parse, located in the file (relative
   * to the task folder). Also reported as a yaml_invalid issue, so the task
   * describes itself; the loader fails the directory with it.
   */
  yamlError: LocatedError | null;
}

/** A prompt that asks for the answer block (plan 4.2: a warning when absent). */
const FENCED_JSON = /```\s*json|fenced\s+json/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A task that has no folder to read: listed in suite.yaml but absent, or not a plain folder. */
export function unreadableTask(key: string, issue: LoadIssue): AnalysedTask {
  return {
    key,
    summary: null,
    prompt: null,
    taskYaml: null,
    limits: null,
    reference: undefined,
    verification: [],
    issues: [issue],
    files: [],
    hashedFiles: [],
    contentHash: contentHash([]),
    rootFiles: [],
    plan: null,
    yamlError: null,
  };
}

export async function analyseTask(
  key: string,
  entries: readonly SuiteEntry[],
  read: TaskReader,
): Promise<AnalysedTask> {
  const issues: LoadIssue[] = [];
  const hashed: HashedFile[] = [];
  const rootFiles: RootFileRead[] = [];
  const byPath = new Map(entries.map((e) => [e.path, e]));

  /** A root file's bytes, or null when absent or unsafe (collectTaskFiles reports unsafe ones). */
  const rootFile = async (name: string): Promise<Buffer | null | 'missing'> => {
    const entry = byPath.get(name);
    if (!entry) return 'missing';
    // Links, special and oversized files are reported by collectTaskFiles.
    if (entry.kind !== 'file' || entry.size > MAX_SUITE_FILE_BYTES) return null;
    const result = await read(name);
    if (!result.ok) {
      issues.push({
        severity: 'error',
        code: 'unsafe_file',
        path: name,
        message: `${name} could not be read safely: ${result.reason}`,
      });
      return null;
    }
    hashed.push({ path: name, sha256: result.sha256 });
    const text = verbatimUtf8(result.content);
    rootFiles.push({
      path: name,
      sha256: result.sha256,
      size: result.content.length,
      text: text !== null && !text.includes('\0') ? text : null,
    });
    return result.content;
  };

  // task.yaml
  let check: TaskYamlCheck | null = null;
  let raw: Record<string, unknown> = {};
  let taskYaml: string | null = null;
  let yamlError: LocatedError | null = null;
  const yamlBytes = await rootFile(TASK_YAML);
  if (yamlBytes === 'missing') {
    issues.push(fileMissing(TASK_YAML, `${TASK_YAML} not found`));
  } else if (yamlBytes !== null) {
    taskYaml = decodeUtf8(yamlBytes);
    if (taskYaml === null) {
      yamlError = locatedError(TASK_YAML, '', null, `${TASK_YAML} is not valid UTF-8 text`);
      issues.push(yamlInvalid(yamlError.message));
    } else {
      const parsed = parseYamlSource(TASK_YAML, taskYaml);
      if (!parsed.ok) {
        yamlError = parsed.error;
        const { line, column, message } = parsed.error;
        issues.push(
          yamlInvalid(line === null ? message : `line ${line}, column ${column}: ${message}`),
        );
      } else {
        check = checkTaskYaml(parsed.value, parsed.doc, parsed.lines);
        issues.push(...check.issues);
        if (isRecord(parsed.value)) raw = parsed.value;
      }
    }
  }

  const layout = fileLayout(raw, byPath, issues);
  const files = await collectTaskFiles(entries, layout, read, issues);
  for (const file of files) if (file.kind === 'home_seed') issues.push(...homeSeedIssues(file));
  for (const dir of [FIXTURES_DIR, VERIFY_DIR, TASK_HOME_DIR]) {
    if (byPath.get(dir)?.kind === 'file') {
      issues.push({
        severity: 'error',
        code: 'schema_invalid',
        path: dir,
        message: `${dir} must be a folder`,
      });
    }
  }

  const prompt = await readPrompt(await rootFile(PROMPT_MD), issues);
  const reference = readReference(await rootFile(REFERENCE_JSON), issues);
  const selfCheck = isRecord(raw.self_check) ? raw.self_check : {};
  // A known-good folder written but unusable has its own error; one cause, one error (Phase 6 #8).
  const written = {
    workspace: selfCheck.expected_workspace !== undefined,
    home: selfCheck.expected_home !== undefined,
  };
  if (check) checkReferencedFiles(check, layout, written, files, byPath, issues);

  for (const file of files) hashed.push({ path: file.path, sha256: file.sha256 });
  const data = check?.data ?? null;
  const verification = check?.verification ?? [];
  const blocked = issues.some((i) => i.severity === 'error');
  const hashedFiles = dedupe(hashed);
  return {
    key,
    summary: data?.summary ?? (typeof raw.summary === 'string' ? raw.summary : null),
    prompt,
    taskYaml,
    limits: data?.limits ?? TaskLimitsSchema.safeParse(raw.limits).data ?? null,
    reference,
    verification,
    issues,
    files: [...files].sort((a, b) => comparePaths(a.path, b.path)),
    hashedFiles,
    contentHash: contentHash(hashedFiles),
    rootFiles: rootFiles.sort((a, b) => comparePaths(a.path, b.path)),
    plan:
      blocked || data === null || reference === undefined
        ? null
        : {
            entries: verification.map(({ key: k, type, params }) => ({ key: k, type, params })),
            reference,
            expectedDir: layout.expectedDir,
            expectedHomeDir: layout.expectedHomeDir,
            negativeControl:
              data.self_check?.negative_control ??
              (layout.expectedDir !== null || layout.expectedHomeDir !== null),
          },
    yamlError,
  };
}

const fileMissing = (path: string, message: string, key?: string): LoadIssue => ({
  severity: 'error',
  code: 'file_missing',
  ...(key !== undefined ? { key } : {}),
  path,
  message,
});

const yamlInvalid = (message: string): LoadIssue => ({
  severity: 'error',
  code: 'yaml_invalid',
  path: TASK_YAML,
  message: `${TASK_YAML}: ${message}`,
});

/** A rubric may be a root file (hashed once) and a task file at the same time. */
function dedupe(files: HashedFile[]): HashedFile[] {
  const seen = new Map<string, HashedFile>();
  for (const f of files) seen.set(f.path, f);
  return [...seen.values()];
}

async function readPrompt(
  bytes: Buffer | null | 'missing',
  issues: LoadIssue[],
): Promise<string | null> {
  if (bytes === 'missing') {
    issues.push(fileMissing(PROMPT_MD, `${PROMPT_MD} not found`));
    return null;
  }
  if (bytes === null) return null;
  const text = decodeUtf8(bytes);
  const invalid = (message: string): null => {
    issues.push({ severity: 'error', code: 'schema_invalid', path: PROMPT_MD, message });
    return null;
  };
  if (text === null) return invalid(`${PROMPT_MD} is not valid UTF-8 text`);
  // Postgres text cannot hold U+0000, and the agent must get the prompt exactly as written.
  if (text.includes('\0')) return invalid(`${PROMPT_MD} contains a NUL character`);
  if (text.trim() === '') return invalid(`${PROMPT_MD} is empty`);
  if (!FENCED_JSON.test(text)) {
    issues.push({
      severity: 'warning',
      code: 'prompt_no_fenced_json',
      path: PROMPT_MD,
      message: `${PROMPT_MD} does not ask for a fenced \`\`\`json block; the answer is read from the last one in the final reply`,
    });
  }
  return text;
}

function readReference(
  bytes: Buffer | null | 'missing',
  issues: LoadIssue[],
): JsonValue | undefined {
  const invalid = (message: string): undefined => {
    issues.push({ severity: 'error', code: 'reference_invalid', path: REFERENCE_JSON, message });
    return undefined;
  };
  if (bytes === 'missing') return invalid(`${REFERENCE_JSON} not found`);
  if (bytes === null) return undefined;
  const text = decodeUtf8(bytes);
  if (text === null) return invalid(`${REFERENCE_JSON} is not valid UTF-8 text`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return invalid(`${REFERENCE_JSON} is not valid JSON: ${(err as Error).message}`);
  }
  const checked = JsonValueSchema.safeParse(value);
  // JSON.parse turns 1e999 into Infinity, which no JSON column can hold.
  if (!checked.success) return invalid(`${REFERENCE_JSON} holds a number that is out of range`);
  return checked.data;
}

/**
 * Files the entries name must exist where the task stores them: a verifier
 * script under verify/, a rubric in the folder, never under fixtures/ or
 * home/, which reach the agent, nor under a known-good folder, whose files
 * are stored as the expected workspace or home (kinds `expected`,
 * `expected_home`), so its llm_judge key would find no rubric and be `error`
 * on every run (Phase 3 question 12). A file_check needs the known-good
 * folder of its root to be proven on: the expected workspace, or with
 * `root: home` the expected home (Phase 6 P2). When task.yaml writes that
 * folder but it is unusable, the folder's own error says so, and the
 * file_check gets no second one (Phase 6 question 8).
 */
function checkReferencedFiles(
  check: TaskYamlCheck,
  layout: FileLayout,
  written: { workspace: boolean; home: boolean },
  files: readonly StoredTaskFile[],
  byPath: ReadonlyMap<string, SuiteEntry>,
  issues: LoadIssue[],
): void {
  const stored = new Set(files.map((f) => f.path));
  check.verification.forEach((entry, i) => {
    const index = check.indices[i]!;
    const at = (field: string) => `task.yaml#verification[${index}].params.${field}`;
    const exists = (path: string) => stored.has(path) || byPath.has(path);
    if (entry.type === 'verifier_script' && typeof entry.params.script === 'string') {
      const path = normaliseRelative(`${VERIFY_DIR}/${entry.params.script}`);
      if (path !== null && !exists(path)) {
        issues.push(
          fileMissing(at('script'), `${entry.key}: verifier script ${path} not found`, entry.key),
        );
      }
    }
    if (entry.type === 'llm_judge' && typeof entry.params.rubric === 'string') {
      const path = normaliseRelative(entry.params.rubric);
      const inside = (dir: string) => path !== null && under(path, dir);
      const reached = [FIXTURES_DIR, TASK_HOME_DIR].find(inside);
      const knownGood = [
        { dir: layout.expectedDir, what: 'the expected workspace (self_check.expected_workspace)' },
        { dir: layout.expectedHomeDir, what: 'the expected home (self_check.expected_home)' },
      ].find((f) => f.dir !== null && inside(f.dir));
      if (reached !== undefined) {
        issues.push({
          severity: 'error',
          code: 'schema_invalid',
          key: entry.key,
          path: at('rubric'),
          message: `${entry.key}: the rubric must not be under ${reached}/, which is copied to the agent`,
        });
      } else if (knownGood !== undefined) {
        issues.push({
          severity: 'error',
          code: 'schema_invalid',
          key: entry.key,
          path: at('rubric'),
          message: `${entry.key}: the rubric must not be under ${knownGood.dir}/, ${knownGood.what}, whose files are the known-good ${knownGood.dir === layout.expectedDir ? 'workspace' : 'home'}; put it beside task.yaml`,
        });
      } else if (path !== null && !exists(path)) {
        issues.push(fileMissing(at('rubric'), `${entry.key}: rubric ${path} not found`, entry.key));
      }
    }
    if (entry.type === 'file_check') {
      const home = fileCheckRootOf(entry.params) === 'home';
      const folder = home ? layout.expectedHomeDir : layout.expectedDir;
      if (folder === null && !(home ? written.home : written.workspace)) {
        issues.push({
          severity: 'error',
          code: 'self_check_unsupported',
          key: entry.key,
          path: `task.yaml#verification[${index}]`,
          message: home
            ? `${entry.key}: file_check with root: home needs self_check.expected_home in task.yaml, the known-good home it is proven on before any agent runs`
            : `${entry.key}: file_check needs self_check.expected_workspace in task.yaml, the known-good workspace it is proven on before any agent runs`,
        });
      }
    }
  });
}
