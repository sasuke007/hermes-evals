/**
 * The loader's issues about a draft task (analyseTask), as readiness issues:
 * which of the 13 rows each belongs to, where its Fix goes, and its message
 * in the words of the task editor (SA.5, SA.7: "Max turns is 1 to 200.",
 * "Tolerance can't be negative."). An issue whose wording the boards do not
 * give keeps the loader's message, without its "(line N)".
 *
 * Every error the loader reports lands on some row as a problem, so a task
 * whose rows hold no problem loads valid (self-checks aside).
 */
import type {
  DraftUploadKind,
  LoadIssue,
  ReadinessIssue,
  ReadinessRule,
  ReadinessTarget,
  TaskEditorSection,
} from '@hermes-evals/shared';
import { MAX_SUITE_FILE_BYTES, PROMPT_MD, REFERENCE_JSON, TASK_YAML } from '../loader/limits.js';
import type { DraftLayout } from './draft-folder.js';

/** A loader path (`task.yaml#verification[1].params.abs`) as its parts: ['verification', 1, 'params', 'abs']. */
export function yamlPathOf(path: string | undefined): (string | number)[] | null {
  if (path === undefined || !path.startsWith(`${TASK_YAML}#`)) return null;
  const out: (string | number)[] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g;
  for (const match of path.slice(TASK_YAML.length + 1).matchAll(pattern)) {
    if (match[1] !== undefined) out.push(match[1]);
    else if (match[2] !== undefined) out.push(Number(match[2]));
    else out.push(JSON.parse(`"${match[3]}"`) as string);
  }
  return out;
}

const FORM_FIELDS: Record<string, string> = {
  max_turns: 'maxTurns',
  run_budget_seconds: 'runBudgetSeconds',
  toolsets_needed: 'toolsetsNeeded',
  expected_workspace: 'expectedWorkspace',
  expected_home: 'expectedHome',
  negative_control: 'negativeControl',
  answers_from_fixtures: 'answersFromFixtures',
};

const target = (section: TaskEditorSection, field: string | null = null): ReadinessTarget => ({
  section,
  field,
});

/** Where a task.yaml path's Fix goes: the form field, or the task.yaml tab for keys the form has none for. */
export function targetOfYamlPath(parts: readonly (string | number)[]): ReadinessTarget {
  const [top, second, third, ...rest] = parts;
  switch (top) {
    case 'summary':
      return target('task', 'summary');
    case 'limits':
      return target('limits', typeof second === 'string' ? (FORM_FIELDS[second] ?? null) : null);
    case 'answer':
      return target('answer', second === 'path' ? 'answerPath' : null);
    case 'verification': {
      if (typeof second !== 'number') return target('checks');
      const base = `checks.${second}`;
      if (third === undefined) return target('checks', base);
      return target('checks', [base, third, ...rest].join('.'));
    }
    case 'self_check': {
      const field = typeof second === 'string' ? (FORM_FIELDS[second] ?? null) : null;
      // answers_from_fixtures sits by the workspace files the leak rule reads.
      const section =
        second === 'expected_home'
          ? 'home'
          : second === 'answers_from_fixtures'
            ? 'workspace'
            : 'expected';
      return target(section, field);
    }
    default:
      return target('yaml');
  }
}

/** Where a file's Fix goes: its section of the editor. */
export function targetOfFile(path: string, layout: DraftLayout): ReadinessTarget {
  if (path === PROMPT_MD) return target('prompt', 'prompt');
  if (path === REFERENCE_JSON) return target('reference', 'reference');
  if (path === TASK_YAML) return target('yaml');
  if (path.startsWith('home/')) return target('home', path);
  if (layout.expectedHomeDir !== null && path.startsWith(`${layout.expectedHomeDir}/`)) {
    return target('home', path);
  }
  if (layout.expectedDir !== null && path.startsWith(`${layout.expectedDir}/`)) {
    return target('expected', path);
  }
  if (layout.rubrics.includes(path)) return target('checks', path);
  return target('workspace', path);
}

/** The section an upload of each kind is made in, where a refused one's Fix goes. */
const UPLOAD_SECTIONS = {
  fixture: 'workspace',
  expected: 'expected',
  home_seed: 'home',
  expected_home: 'home',
} as const satisfies Record<DraftUploadKind, TaskEditorSection>;

/** Where the Fix of an upload refused for its size goes: its kind's section, its path as the field. */
export const targetOfUpload = (kind: DraftUploadKind, path: string): ReadinessTarget =>
  target(UPLOAD_SECTIONS[kind], path);

/** The loader's message without the "(line 12)" it ends with and the key it starts with. */
const bare = (message: string, key?: string): string => {
  let out = message.replace(/ \(line \d+\)$/, '');
  if (key !== undefined && out.startsWith(`${key}: `)) out = out.slice(key.length + 2);
  out = out.replace(/^(params\.)?[A-Za-z_]+(\[\d+\])?: /, '');
  return /[.?!]$/.test(out) ? out : `${out}.`;
};

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A check's settings problem in the card's words (SA.7 "Settings errors"). */
function paramMessage(field: string | number | undefined, issue: LoadIssue): string {
  const message = issue.message;
  if (/The pattern is not valid/.test(message))
    return bare(message.slice(message.indexOf('The pattern')));
  if (/Unrecognized key/.test(message)) return `Unknown setting \`${String(field)}\`.`;
  // A required setting a new card has no value for yet (zod: "expected string, received undefined").
  if (/received undefined/.test(message)) {
    return field === 'path' ? 'Add the file path.' : `Add \`${String(field)}\`.`;
  }
  switch (field) {
    case 'abs':
    case 'rel':
      return "Tolerance can't be negative.";
    case 'pass_at':
      return 'Use a number between 0 and 1.';
    case 'timeout_s':
      return 'Timeout is 1 to 300 seconds.';
    case 'max_calls':
      if (/at least min_calls/.test(message)) return 'Max calls must be at least min calls.';
      break;
    case 'columns':
    case 'row_count':
      if (/needs format: csv/.test(message)) return 'Columns and row count need format csv.';
      break;
    case 'json_schema':
      if (/needs format: json/.test(message)) return 'A JSON Schema needs format json.';
      break;
  }
  return bare(message, issue.key);
}

export interface MappedIssue extends ReadinessIssue {
  /** The loader's own issue, kept for rows that look at codes. */
  code: LoadIssue['code'];
}

/** One loader issue as a readiness issue. */
export function mapIssue(issue: LoadIssue, layout: DraftLayout): MappedIssue {
  const severity = issue.severity === 'error' ? 'problem' : 'warning';
  const at = (rule: ReadinessRule, t: ReadinessTarget, message: string): MappedIssue => ({
    rule,
    severity,
    target: t,
    message,
    code: issue.code,
  });
  const parts = yamlPathOf(issue.path);
  if (parts !== null) {
    const t = targetOfYamlPath(parts);
    const [top, index, inEntry, field] = parts;
    const unknown = /Unrecognized key: "([^"]+)"/.exec(issue.message)?.[1];
    if (unknown !== undefined && inEntry !== 'params') {
      const line = /\(line (\d+)\)$/.exec(issue.message)?.[1];
      return at(
        'task_yaml',
        target('yaml'),
        `${line ? `line ${line}: ` : ''}unknown key \`${unknown}\``,
      );
    }
    if (issue.code === 'primary_count')
      return at('checks', t, 'Mark exactly one check as primary.');
    if (issue.code === 'duplicate_key') {
      return at('check_settings', t, `Two checks are named \`${issue.key ?? ''}\`.`);
    }
    if (issue.code === 'self_check_unsupported') {
      const home = /root: home/.test(issue.message);
      return at(
        'expected_folders',
        target(home ? 'home' : 'expected'),
        `\`${issue.key ?? ''}\` needs an expected ${home ? 'home' : 'workspace'}.`,
      );
    }
    if (top === 'summary') return at('key_summary', t, 'Add a one-line summary.');
    if (top === 'limits') {
      if (index === 'max_turns') return at('task_yaml', t, 'Max turns is 1 to 200.');
      if (index === 'run_budget_seconds')
        return at('task_yaml', t, 'Run budget is 30 to 3600 seconds.');
      return at('task_yaml', t, bare(issue.message));
    }
    if (top === 'verification') {
      if (index === undefined) {
        const none = /at least 1|>=1|too small/i.test(issue.message);
        return none
          ? at('checks', t, 'Add at least one check.')
          : at('check_settings', t, bare(issue.message));
      }
      if (inEntry === 'key') {
        return at(
          'check_settings',
          t,
          /reserved/.test(issue.message)
            ? bare(issue.message)
            : 'Check keys use lowercase letters, digits and `_`, starting with a letter.',
        );
      }
      if (inEntry === 'params') return at('check_settings', t, paramMessage(field, issue));
      return at('check_settings', t, bare(issue.message, issue.key));
    }
    if (top === 'self_check') {
      if (issue.code === 'file_missing') {
        const dir = /folder (\S+)\/ not found/.exec(issue.message)?.[1] ?? '';
        return at('expected_folders', t, `\`${dir}/\` has no files.`);
      }
      return at('expected_folders', t, bare(issue.message));
    }
    return at('task_yaml', t, bare(issue.message));
  }
  switch (issue.code) {
    case 'yaml_invalid':
      return at('task_yaml', target('yaml'), bare(issue.message.replace(/^task\.yaml: /, '')));
    case 'reference_invalid':
      return at(
        'reference_json',
        target('reference', 'reference'),
        /not found/.test(issue.message)
          ? 'Add the reference answer.'
          : bare(issue.message.replace(/^reference\.json /, 'The reference ')),
      );
    case 'prompt_no_fenced_json':
      return at(
        'answer_block',
        target('prompt', 'prompt'),
        "The prompt doesn't ask for a fenced json block.",
      );
    case 'file_missing':
      if (issue.path === TASK_YAML)
        return at('task_yaml', target('yaml'), '`task.yaml` is missing.');
      if (issue.path === PROMPT_MD)
        return at('answer_block', target('prompt', 'prompt'), 'The prompt is empty.');
      break;
    case 'schema_invalid':
      if (issue.path === PROMPT_MD) {
        return at(
          'answer_block',
          target('prompt', 'prompt'),
          /is empty/.test(issue.message) ? 'The prompt is empty.' : bare(issue.message),
        );
      }
      break;
    case 'unsafe_file':
      if (issue.path !== undefined && /larger than/.test(issue.message)) {
        return at(
          'file_limits',
          targetOfFile(issue.path, layout),
          `\`${baseName(issue.path)}\` is over ${MAX_SUITE_FILE_BYTES / 1024 / 1024} MB.`,
        );
      }
      break;
  }
  const file = issue.path ?? '';
  return at(
    'file_limits',
    file === '' ? target('workspace') : targetOfFile(file, layout),
    bare(issue.message),
  );
}
