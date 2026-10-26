/**
 * The readiness rules of a draft task (plan 4.6, board SA.8, note n_sa8):
 * the 13 rows of ReadinessPanel, run in the API on every change of the task,
 * without running user code.
 *
 * What they are made of:
 * - the shared zod schemas (TaskYamlSchema, SCORER_PARAM_SCHEMAS,
 *   VerificationKeySchema, TaskLimitsSchema);
 * - the loader's pure task analysis on an in-memory folder (analyseTask and
 *   checkTaskYaml take a TaskReader, so the draft's texts and blobs stand in
 *   for the disk), which also gives the task's content hash;
 * - answer-mode self-checks, which score the reference with the answer
 *   scorers and need no worker (`selfCheckModeFor` says which checks are
 *   answer checks; file checks and verifier scripts stay `pending` until
 *   POST …/self-check runs them in the worker);
 * - the cross-checks: every path a check reads resolves in the reference;
 *   every file the prompt mentions is in the workspace (or the expected
 *   workspace, or the home seeds); no text fixture contains a reference leaf
 *   value of 4 or more characters; file checks have an expected workspace,
 *   and home checks an expected home.
 *
 * Every loader issue lands on a row (readiness-issues.ts), so a task with no
 * problem loads valid but for its self-checks. Problems never block saving:
 * a task with problems is saved and loads as invalid, exactly as the same
 * files would on disk.
 */
import {
  DIRECTORY_KEY_MESSAGE,
  DIRECTORY_KEY_PATTERN,
  READINESS_RULES,
  summariseReadiness,
  type ReadinessIssue,
  type ReadinessRule,
  type ReadinessRuleResult,
  type TaskReadiness,
} from '@hermes-evals/shared';
import type { DraftSelfCheckRecord } from '../../database/schema/index.js';
import { analyseTask, type AnalysedTask } from '../loader/task.js';
import { decodeUtf8 } from '../loader/task-files.js';
import { parseYamlSource, positionOf } from '../loader/yaml-source.js';
import { folderReader, layoutOf } from './draft-folder.js';
import type { DraftTaskFolder } from './materialise.js';
import {
  codeList,
  describeValue,
  locateMentions,
  mentionedNames,
  mentionsPresent,
  referenceLeaks,
  referenceLeaves,
  referenceReads,
} from './readiness-cross.js';
import { mapIssue, type MappedIssue } from './readiness-issues.js';
import { selfCheckRows } from './readiness-self-check.js';

/** What the rules need beyond the task's own files. */
export interface ReadinessContext {
  /** The suite folder, for messages: "total_due is already a task in invoices-v1." */
  folder: string;
  /** The keys of the draft's other tasks, removed ones included: a key taken twice is a problem. */
  otherKeys: readonly string[];
  /** The base task's key when the task was renamed (the rename note), else null. */
  renamedFrom: string | null;
  /** A blob's bytes, for the leak rule (text fixtures) and the mentioned-files rule. */
  readBlob: (sha256: string) => Promise<Buffer>;
  /**
   * The task's last worker self-check, with the content hash it ran on. Rows
   * 12 and 13 show it while it matches the task's content, and `pending`
   * once an edit made it out of date; an untouched task of the base keeps
   * its base version's self-check (passed in here by the caller).
   */
  lastSelfCheck: DraftSelfCheckRecord | null;
  now?: () => Date;
}

export interface ReadinessOutcome {
  /** The panel, the field messages, and what the Prompt and Reference sections list. */
  readiness: TaskReadiness;
  /**
   * The loader's analysis of the draft folder. Its `contentHash` is what the
   * draft task stores (suite_draft_tasks.content_hash): equal to the base
   * task's hash exactly when the task is unchanged.
   */
  analysis: AnalysedTask;
}

/** Text fixtures larger than this are not searched for reference values. */
const LEAK_SCAN_MAX_BYTES = 5 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "line 1, col 21: Expected ',' or '}' after property value." for reference.json that does not parse. */
export function jsonErrorMessage(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    const message = (err as Error).message;
    const at = /position (\d+)/.exec(message);
    const short = message
      .replace(/ in JSON at position \d+.*$/, '')
      .replace(/, ".*" is not valid JSON$/s, '')
      .replace(/^JSON\.parse: /, '');
    const sentence = /[.!?]$/.test(short) ? short : `${short}.`;
    if (!at) return sentence;
    const before = text.slice(0, Number(at[1]));
    const line = before.split('\n').length;
    const column = before.length - before.lastIndexOf('\n');
    return `line ${line}, col ${column}: ${sentence}`;
  }
}

/** Runs the 13 rules of SA.8 on `task` and returns them with their summary. Never throws for the task's content. */
export async function evaluateReadiness(
  task: DraftTaskFolder,
  context: ReadinessContext,
): Promise<ReadinessOutcome> {
  const now = context.now ?? (() => new Date());
  const { entries, read } = folderReader(task, context.readBlob);
  const analysis = await analyseTask(task.key, entries, read);
  const layout = layoutOf(task.taskYaml);
  const parsed = task.taskYaml === null ? null : parseYamlSource('task.yaml', task.taskYaml);
  const raw = parsed?.ok && isRecord(parsed.value) ? parsed.value : {};
  const rawChecks: unknown[] = Array.isArray(raw.verification) ? raw.verification : [];
  const indexOf = (key: string) => rawChecks.findIndex((e) => isRecord(e) && e.key === key);
  const yamlBroken = analysis.yamlError !== null;

  const issues: MappedIssue[] = analysis.issues.map((i) => mapIssue(i, layout));
  const extra = (
    rule: ReadinessRule,
    severity: 'problem' | 'warning',
    target: ReadinessIssue['target'],
    message: string,
  ) => issues.push({ rule, severity, target, message, code: 'schema_invalid' });

  // Rule 5: where reference.json stops parsing.
  if (task.reference !== null && task.reference.trim() !== '') {
    const located = jsonErrorMessage(task.reference);
    for (const issue of issues) {
      if (issue.rule === 'reference_json' && located !== null) issue.message = located;
    }
  } else {
    for (const issue of issues) {
      if (issue.rule === 'reference_json') issue.message = 'Add the reference answer.';
    }
  }

  // Rule 1: the key, beside the summary the schema checks.
  const keyTarget = { section: 'task' as const, field: 'key' };
  if (!DIRECTORY_KEY_PATTERN.test(task.key))
    extra('key_summary', 'problem', keyTarget, DIRECTORY_KEY_MESSAGE);
  if (context.otherKeys.includes(task.key)) {
    extra(
      'key_summary',
      'problem',
      keyTarget,
      `\`${task.key}\` is already a task in \`${context.folder}\`.`,
    );
  }
  if (context.renamedFrom !== null && context.renamedFrom !== task.key) {
    extra(
      'key_summary',
      'warning',
      keyTarget,
      `Renaming makes this a new task. Results recorded under \`${context.renamedFrom}\` won't compare with results under the new key.`,
    );
  }

  // Rule 2 names the second primary where task.yaml marks it.
  const primaries = rawChecks.flatMap((e, i) => (isRecord(e) && e.primary === true ? [i] : []));
  if (primaries.length > 1 && parsed?.ok) {
    const pos = positionOf(parsed.doc, parsed.lines, ['verification', primaries[1]!, 'primary']);
    extra(
      'task_yaml',
      'problem',
      { section: 'yaml', field: null },
      `${pos ? `line ${pos.line}: ` : ''}a second check has \`primary: true\`.`,
    );
  }

  // Rule 6: the values the answer checks read.
  const reads =
    analysis.reference === undefined
      ? []
      : referenceReads(analysis.verification, analysis.reference);
  const ownsPath = (key: string) => {
    const entry = rawChecks[indexOf(key)];
    return isRecord(entry) && isRecord(entry.params) && 'path' in entry.params;
  };
  for (const r of reads) {
    const target = ownsPath(r.key)
      ? { section: 'checks' as const, field: `checks.${indexOf(r.key)}.params.path` }
      : { section: 'answer' as const, field: 'answerPath' };
    if (!r.found) {
      extra(
        'reference_paths',
        'problem',
        target,
        r.malformed
          ? `\`${r.path}\` is not a valid path (check \`${r.key}\`).`
          : `No value at \`${r.path ?? '$'}\` (check \`${r.key}\`).`,
      );
    } else if (r.type === 'exact_match' && typeof r.value === 'object' && r.value !== null) {
      const kind = Array.isArray(r.value) ? ['the list', 'a list'] : ['the object', 'an object'];
      extra(
        'reference_paths',
        'warning',
        target,
        `\`${r.key}\` compares ${kind[0]} ${r.path ? `\`${r.path}\`` : 'at the root'} as text. JSON match fits ${kind[1]}.`,
      );
    }
  }

  // Rule 9: files the prompt mentions.
  const mentioned = locateMentions(
    mentionedNames(task.prompt ?? ''),
    task.files.map((f) => f.path),
    layout.expectedDir,
  );
  const missing = mentioned.filter((m) => m.location === 'missing').map((m) => m.name);
  if (missing.length > 0) {
    extra(
      'mentioned_files',
      'warning',
      { section: 'workspace', field: null },
      `${codeList(missing)} ${missing.length === 1 ? 'is' : 'are'} mentioned but not in workspace files.`,
    );
  }

  // Rule 10: reference values in text fixtures.
  if (analysis.reference !== undefined) {
    const leaves = referenceLeaves(analysis.reference);
    const fixtures: { path: string; text: string }[] = [];
    if (leaves.length > 0) {
      for (const file of task.files) {
        if (file.kind !== 'fixture' || file.size > LEAK_SCAN_MAX_BYTES) continue;
        const text = decodeUtf8(await context.readBlob(file.sha256).catch(() => Buffer.alloc(0)));
        if (text !== null) fixtures.push({ path: file.path, text });
      }
    }
    for (const leak of referenceLeaks(leaves, fixtures)) {
      extra(
        'reference_leak',
        'warning',
        { section: 'workspace', field: leak.file },
        `\`${leak.file}\` contains \`${leak.leaf.text}\`, the reference value at \`${leak.leaf.path}\`. The agent could read the answer.`,
      );
    }
  }

  // Rows 12 and 13.
  const folders = {
    expectedWorkspace: layout.expectedDir !== null,
    expectedHome: layout.expectedHomeDir !== null,
  };
  const selfCheck = isRecord(raw.self_check) ? raw.self_check : {};
  const negativeControl =
    typeof selfCheck.negative_control === 'boolean'
      ? selfCheck.negative_control
      : folders.expectedWorkspace || folders.expectedHome;
  const checkRows = selfCheckRows({
    verification: analysis.verification,
    reference: analysis.reference,
    folders,
    negativeControl,
    lastSelfCheck: context.lastSelfCheck,
    contentHash: analysis.contentHash,
    indexOf,
  });

  const passedMessage = (rule: ReadinessRule): ReadinessRuleResult => {
    const pass = (message = ''): ReadinessRuleResult => ({
      rule,
      status: 'passed',
      message,
      target: null,
    });
    const pending = (message: string): ReadinessRuleResult => ({
      rule,
      status: 'pending',
      message,
      target: null,
    });
    const waitsOnYaml = 'Shown once `task.yaml` is valid.';
    switch (rule) {
      case 'checks': {
        if (yamlBroken) return pending(waitsOnYaml);
        const primary = rawChecks.find((e) => isRecord(e) && e.primary === true) as
          Record<string, unknown> | undefined;
        return pass(
          primary
            ? `\`${String(primary.key)}\` is primary · ${plural(rawChecks.length, 'check')}`
            : '',
        );
      }
      case 'check_settings':
        return yamlBroken ? pending(waitsOnYaml) : pass();
      case 'reference_paths':
        if (yamlBroken) return pending(waitsOnYaml);
        if (analysis.verification.length === 0) return pending('Shown once a check reads a path.');
        if (task.reference === null || task.reference.trim() === '') {
          return pending('Enter the reference to see the values the checks read.');
        }
        if (analysis.reference === undefined) {
          return pending('Values can be read once the reference is valid JSON.');
        }
        if (reads.length === 0) return pass('No check reads the reference.');
        return pass(
          reads
            .map(
              (r) =>
                `\`${r.key}\` reads ${r.path === null ? 'the whole reference' : `\`${r.path}\``}: ${describeValue(r.value!)}.`,
            )
            .join(' '),
        );
      case 'expected_folders': {
        if (yamlBroken) return pending(waitsOnYaml);
        const counts: string[] = [];
        if (layout.expectedDir !== null) {
          counts.push(
            `\`${layout.expectedDir}/\` has ${plural(task.files.filter((f) => f.kind === 'expected').length, 'file')}.`,
          );
        }
        if (layout.expectedHomeDir !== null) {
          counts.push(
            `\`${layout.expectedHomeDir}/\` has ${plural(task.files.filter((f) => f.kind === 'expected_home').length, 'file')}.`,
          );
        }
        const fileChecks = analysis.verification.some((v) => v.type === 'file_check');
        return pass(counts.length > 0 ? counts.join(' ') : fileChecks ? '' : 'No file checks.');
      }
      case 'mentioned_files':
        return pass(mentionsPresent(mentioned));
      case 'self_check':
        return yamlBroken ? pending(waitsOnYaml) : checkRows.selfCheck;
      case 'negative_control':
        return yamlBroken ? pending(waitsOnYaml) : checkRows.negativeControl;
      default:
        return pass();
    }
  };

  for (const r of [checkRows.selfCheck, checkRows.negativeControl]) {
    if (!yamlBroken && (r.status === 'problem' || r.status === 'warning') && r.target !== null) {
      extra(r.rule, r.status, r.target, r.message);
    }
  }
  const rules = READINESS_RULES.map((rule): ReadinessRuleResult => {
    if (rule === 'self_check' || rule === 'negative_control') return passedMessage(rule);
    const own = issues.filter((i) => i.rule === rule);
    const worst =
      own.find((i) => i.severity === 'problem') ?? own.find((i) => i.severity === 'warning');
    if (worst === undefined) return passedMessage(rule);
    return { rule, status: worst.severity, message: worst.message, target: worst.target };
  });
  const { summary, counts } = summariseReadiness(rules);
  return {
    readiness: {
      summary,
      counts,
      rules,
      issues: issues.map(({ rule, severity, target, message }) => ({
        rule,
        severity,
        target,
        message,
      })),
      mentionedFiles: mentioned,
      referenceValues: reads.map(({ key, path, found, preview }) => ({
        key,
        path,
        found,
        preview,
      })),
      needsWorker: checkRows.needsWorker,
      checkedAt: now().toISOString(),
    },
    analysis,
  };
}
