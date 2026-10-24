import { parseDocument, LineCounter } from 'yaml';
import { parseSuiteYaml } from './suite-yaml.js';
import { excerptText, formatPath, parseYamlSource, positionOf } from './yaml-source.js';

describe('parseYamlSource', () => {
  it('locates a syntax error and quotes the lines before it with a caret', () => {
    const source = 'a: 1\nb: 2\nc: 3\nd: e: f\n';
    const parsed = parseYamlSource('task.yaml', source);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatchObject({ file: 'task.yaml', line: 4, column: 4 });
    expect(parsed.error.message).toBe('Nested mappings are not allowed in compact mappings');
    expect(parsed.error.excerpt).toEqual([
      { line: 2, text: 'b: 2', highlight: false },
      { line: 3, text: 'c: 3', highlight: false },
      { line: 4, text: 'd: e: f', highlight: true },
      { line: null, text: '   ^', highlight: false },
    ]);
  });

  it('refuses duplicate keys and a second document', () => {
    const dup = parseYamlSource('x.yaml', 'a: 1\na: 2\n');
    expect(dup.ok || dup.error).toMatchObject({ line: 2, message: 'Map keys must be unique' });
    const two = parseYamlSource('x.yaml', 'a: 1\n---\nb: 2\n');
    expect(two.ok).toBe(false);
  });

  it('reports an unresolved alias without a position', () => {
    const parsed = parseYamlSource('x.yaml', 'a: *missing\n');
    expect(parsed.ok || parsed.error).toMatchObject({ line: null, column: null, excerpt: [] });
  });

  it('bounds alias expansion', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 10; i += 1) {
      const prev = String.fromCharCode(96 + i);
      const name = String.fromCharCode(97 + i);
      lines.push(`${name}: &${name} [${Array(10).fill(`*${prev}`).join(', ')}]`);
    }
    const parsed = parseYamlSource('x.yaml', `${lines.join('\n')}\n`);
    expect(parsed.ok).toBe(false);
  });

  it('keeps a long line short in the excerpt', () => {
    const parsed = parseYamlSource('x.yaml', `a: ${'x'.repeat(300)}: y\n`);
    expect(parsed.ok || parsed.error.excerpt[0]!.text.length).toBeLessThanOrEqual(201);
  });
});

describe('excerptText', () => {
  it('numbers each line, marks the failing one and keeps the caret line as is', () => {
    const text = excerptText([
      { line: 9, text: 'a: 1', highlight: false },
      { line: 10, text: 'b: [', highlight: true },
      { line: null, text: '   ^', highlight: false },
    ]);
    expect(text).toBe('   9 | a: 1\n> 10 | b: [\n   ^');
    expect(excerptText([])).toBeNull();
  });
});

describe('formatPath', () => {
  it('writes keys dotted, indices bracketed and odd keys quoted', () => {
    expect(formatPath(['verification', 1, 'params', 'path'])).toBe('verification[1].params.path');
    expect(formatPath([0, 'a'])).toBe('[0].a');
    expect(formatPath(['weird key', 'x'])).toBe('["weird key"].x');
    expect(formatPath([])).toBe('');
  });
});

describe('positionOf', () => {
  const source =
    'summary: x\nlimits:\n  max_turns: 900\nverification:\n  - key: a\n    params: { path: p }\n';
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines });

  it('points at the key of a mapping entry and at a list item', () => {
    expect(positionOf(doc, lines, ['limits', 'max_turns'])).toEqual({ line: 3, column: 3 });
    expect(positionOf(doc, lines, ['verification', 0])).toEqual({ line: 5, column: 5 });
    expect(positionOf(doc, lines, ['verification', 0, 'params', 'path'])).toEqual({
      line: 6,
      column: 15,
    });
  });

  it('falls back to the deepest node that exists', () => {
    expect(positionOf(doc, lines, ['limits', 'run_budget_seconds'])).toEqual({
      line: 2,
      column: 1,
    });
  });
});

describe('parseSuiteYaml', () => {
  it('turns a numeric version label into its string', () => {
    const parsed = parseSuiteYaml('name: s\nversion_label: 0.3\n');
    expect(parsed).toEqual({ ok: true, suite: { name: 's', version_label: '0.3' } });
  });

  it('points a schema error at the offending key', () => {
    const parsed = parseSuiteYaml("name: s\nversion_label: '1'\nauthor: me\n");
    expect(parsed.ok || parsed.error).toMatchObject({
      file: 'suite.yaml',
      line: 3,
      column: 1,
      message: expect.stringMatching(/^author: /),
    });
  });

  it('says what is missing', () => {
    const parsed = parseSuiteYaml('name: s\n');
    expect(parsed.ok || parsed.error.message).toMatch(/^version_label: /);
  });

  it('refuses a name that cannot be a directory key', () => {
    const parsed = parseSuiteYaml("name: '../x'\nversion_label: '1'\n");
    expect(parsed.ok || parsed.error).toMatchObject({
      line: 1,
      message: expect.stringMatching(/^name: /),
    });
  });
});
