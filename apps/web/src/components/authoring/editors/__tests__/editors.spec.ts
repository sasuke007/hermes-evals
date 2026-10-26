/**
 * The authoring editors (Components 5): line numbers that follow the text, the error line
 * with its gutter mark and underlined token, MarkdownEditor's Edit · Preview and count, the
 * JSON parse error at its line and column, and YamlEditor's located error with its
 * suggestion applied in place.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import CodeTextArea from '../CodeTextArea.vue';
import JsonEditor from '../JsonEditor.vue';
import MarkdownEditor from '../MarkdownEditor.vue';
import YamlEditor from '../YamlEditor.vue';
import {
  codeSegments,
  jsonProblem,
  markdownBlocks,
  primaryLines,
  yamlSuggestion,
} from '../editorText';

describe('CodeTextArea', () => {
  it('numbers each line of the text and emits what is typed', async () => {
    const w = mount(CodeTextArea, { props: { modelValue: 'a\nb\nc', label: 'Prompt' } });
    expect(w.findAll('[data-line]').map((l) => l.attributes('data-line'))).toEqual(['1', '2', '3']);
    await w.get('textarea').setValue('a\nb');
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['a\nb']);
    expect(w.get('textarea').attributes('aria-label')).toBe('Prompt');
  });

  it('marks the error line and underlines the token at its column', () => {
    const w = mount(CodeTextArea, {
      props: {
        modelValue: 'verification:\n      prmary: true',
        label: 'task.yaml',
        errorLine: 2,
        errorColumn: 7,
      },
    });
    expect(w.get('[data-line="2"]').attributes('data-marked')).toBe('true');
    expect(w.get('[data-testid="squiggle"]').text()).toBe('prmary');
    expect(w.findAll('[aria-label="Error on this line"]')).toHaveLength(1);
  });

  it('is read-only when asked', () => {
    const w = mount(CodeTextArea, { props: { modelValue: 'x', label: 'x', readonly: true } });
    expect(w.get('textarea').attributes('readonly')).toBeDefined();
  });
});

describe('MarkdownEditor', () => {
  it('counts characters and previews blocks', async () => {
    const text =
      'Your directory has `invoices.csv`.\n\n# Heading\n- item\n\n```json\n{ "a": 1 }\n```';
    const w = mount(MarkdownEditor, { props: { modelValue: text, label: 'Prompt' } });
    expect(w.get('[data-testid="char-count"]').text()).toBe(`${text.length} characters`);
    await w.get('button[aria-pressed="false"]').trigger('click');
    const preview = w.get('[data-testid="markdown-preview"]');
    expect(preview.find('code').text()).toBe('invoices.csv');
    expect(preview.find('b').text()).toBe('Heading');
    expect(preview.find('pre').text()).toBe('{ "a": 1 }');
  });

  it('says it is read-only while task.yaml has an error', () => {
    const w = mount(MarkdownEditor, { props: { modelValue: '', label: 'Prompt', readonly: true } });
    expect(w.text()).toContain('Read-only until task.yaml is fixed.');
    expect(w.get('textarea').attributes('placeholder')).toBe(
      'Write exactly what the agent receives.',
    );
  });
});

describe('JsonEditor', () => {
  it('states where the JSON stops parsing, as SA.5 words it', () => {
    const w = mount(JsonEditor, {
      props: { modelValue: '{"overdue_count":17 "n":1}', label: 'Reference' },
    });
    expect(w.get('[data-testid="json-error"]').text()).toBe(
      'Not valid JSON: line 1, col 21: expected , or }.',
    );
    expect(w.get('[data-testid="squiggle"]').text()).toBe('"');
  });

  it('shows no error for valid or empty JSON, and the read-only line', () => {
    expect(
      mount(JsonEditor, { props: { modelValue: '{ "a": [1, 2] }', label: 'x' } })
        .find('[data-testid="json-error"]')
        .exists(),
    ).toBe(false);
    expect(
      mount(JsonEditor, { props: { modelValue: '', label: 'x' } })
        .find('[data-testid="json-error"]')
        .exists(),
    ).toBe(false);
    expect(
      mount(JsonEditor, { props: { modelValue: '1', label: 'x', readonly: true } }).text(),
    ).toContain('Read-only.');
  });
});

describe('YamlEditor', () => {
  const text = 'verification:\n  - key: answer\n    prmary: true\n';
  const error = { line: 3, column: 5, message: 'unknown key `prmary`. Did you mean `primary`?' };

  it('shows the located error and changes the token to the suggestion', async () => {
    const w = mount(YamlEditor, {
      props: { modelValue: text, path: 'overdue_count/task.yaml', error },
    });
    expect(w.get('[data-testid="yaml-status"]').text()).toBe('1 error');
    expect(w.get('[data-testid="yaml-error"]').text()).toContain(
      'line 3, col 5: unknown key prmary.',
    );
    expect(w.get('[data-testid="squiggle"]').text()).toBe('prmary');
    await w.get('[data-testid="yaml-error"] button').trigger('click');
    expect(w.emitted('update:modelValue')?.[0]).toEqual([
      'verification:\n  - key: answer\n    primary: true\n',
    ]);
  });

  it('reads valid when there is no error', () => {
    const w = mount(YamlEditor, { props: { modelValue: text, path: 'x/task.yaml' } });
    expect(w.get('[data-testid="yaml-status"]').text()).toBe('valid · written as shown');
    expect(w.text()).toContain('Your comments and key order are kept.');
  });
});

describe('editor text helpers', () => {
  it('splits code runs, blocks and suggestions', () => {
    expect(codeSegments('a `b` c')).toEqual([
      { text: 'a ', code: false },
      { text: 'b', code: true },
      { text: ' c', code: false },
    ]);
    expect(markdownBlocks('- one\n\ntext').map((b) => b.kind)).toEqual(['li', 'p']);
    expect(
      primaryLines(
        'verification:\n  - key: a\n    primary: true\n  # primary: true\n  - { key: b, primary: true }\n',
      ),
    ).toEqual([3, 5]);
    expect(yamlSuggestion('unknown key `prmary`. Did you mean `primary`?')).toEqual({
      token: 'prmary',
      suggestion: 'primary',
    });
    expect(jsonProblem('[1, 2')).toMatchObject({
      line: 1,
      column: 6,
      message: 'unexpected end, expected `,` or `]`',
    });
    expect(jsonProblem('{ "a": tru }')).toMatchObject({ column: 8 });
  });
});
