/**
 * Pure helpers of the authoring editors: the blocks MarkdownEditor previews, where a JSON
 * text stops parsing (JsonEditor, SA.5: "Not valid JSON: line 1, col 21: expected , or }."),
 * text split into `code` and plain runs (the boards set every `name` in mono), and the
 * located parts of a task.yaml message (YamlEditor, SA.6).
 */

export type MarkdownBlock =
  | { kind: 'p'; segments: TextSegment[] }
  | { kind: 'h'; text: string }
  | { kind: 'li'; text: string }
  | { kind: 'code'; text: string };

export interface TextSegment {
  text: string;
  code: boolean;
}

/** `a \`b\` c` → plain a, code b, plain c (empty runs dropped). */
export function codeSegments(text: string): TextSegment[] {
  return text
    .split('`')
    .map((t, i) => ({ text: t, code: i % 2 === 1 }))
    .filter((s) => s.text !== '');
}

/** The few blocks the preview draws: fenced code, `# ` headings, `- ` items, paragraphs. */
export function markdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      blocks.push({ kind: 'code', text: body.join('\n') });
    } else if (line.trim() === '') {
      i++;
    } else if (/^#{1,6} /.test(line)) {
      blocks.push({ kind: 'h', text: line.replace(/^#+ /, '') });
      i++;
    } else if (/^[-*] /.test(line)) {
      blocks.push({ kind: 'li', text: line.slice(2) });
      i++;
    } else {
      blocks.push({ kind: 'p', segments: codeSegments(line) });
      i++;
    }
  }
  return blocks;
}

export interface JsonProblem {
  line: number;
  column: number;
  /** "expected `,` or `}`", in the words of the boards. */
  message: string;
}

/** Where a JSON text stops being JSON, or null when it parses (an empty text is not JSON). */
export function jsonProblem(text: string): JsonProblem | null {
  if (text.trim() === '') return null;
  try {
    JSON.parse(text);
    return null;
  } catch {
    return locateJsonError(text);
  }
}

/**
 * A small scanner that finds the first character a JSON parser refuses, so the message is
 * the same in every browser: engines word and place JSON.parse errors differently.
 */
function locateJsonError(text: string): JsonProblem {
  let i = 0;
  const at = (index: number, message: string): JsonProblem => {
    const before = text.slice(0, index).split('\n');
    return { line: before.length, column: before[before.length - 1]!.length + 1, message };
  };
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const fail = (expected: string): never => {
    throw at(i, i >= text.length ? `unexpected end, expected ${expected}` : `expected ${expected}`);
  };
  const literal = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail('a value');
  };
  const string = () => {
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail('`"`');
    i++;
  };
  const number = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) fail('a value');
    i += match![0].length;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') return container('}', true);
    if (c === '[') return container(']', false);
    if (c === '"') return string();
    if (c === 't') return literal('true');
    if (c === 'f') return literal('false');
    if (c === 'n') return literal('null');
    if (c !== undefined && /[-\d]/.test(c)) return number();
    fail('a value');
  };
  const container = (close: string, keyed: boolean): void => {
    i++;
    ws();
    if (text[i] === close) {
      i++;
      return;
    }
    for (;;) {
      ws();
      if (keyed) {
        if (text[i] !== '"') fail('`"`');
        string();
        ws();
        if (text[i] !== ':') fail('`:`');
        i++;
      }
      value();
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === close) {
        i++;
        return;
      }
      fail(`\`,\` or \`${close}\``);
    }
  };
  try {
    value();
    ws();
    if (i < text.length) fail('the end of the text');
  } catch (problem) {
    if (problem && typeof problem === 'object' && 'line' in problem) return problem as JsonProblem;
  }
  return at(Math.min(i, text.length), 'not valid JSON');
}

/** The parts of a task.yaml message the editor draws: the bad token and the suggestion. */
export function yamlSuggestion(message: string): {
  token: string | null;
  suggestion: string | null;
} {
  const token = /unknown key `?([^`\s.]+)`?/.exec(message)?.[1] ?? null;
  const suggestion = /Did you mean `?([^`\s?]+)`?\?/.exec(message)?.[1] ?? null;
  return { token, suggestion };
}

/** The lock message of a task.yaml that marks two checks primary (the API's task-form.ts). */
export const SECOND_PRIMARY = 'a second check is marked primary.';

/**
 * The lines (1-based) of task.yaml that mark a check primary, `primary: true` in block or flow
 * style, comments left out: with two primaries the editor marks both (SA.5).
 */
export function primaryLines(yaml: string): number[] {
  const lines: number[] = [];
  yaml.split('\n').forEach((line, i) => {
    const code = line.replace(/(^|\s)#.*$/, '');
    if (/(^|[\s{,-])primary:\s*true\b/.test(code)) lines.push(i + 1);
  });
  return lines;
}
