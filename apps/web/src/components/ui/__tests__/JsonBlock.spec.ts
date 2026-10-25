import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import JsonBlock from '@/components/ui/JsonBlock.vue';

const TEXT =
  'I checked invoices.csv for invoices that appear more than once.\n\n```json\n{"duplicates": []}\n```';
const FENCE = { start: TEXT.indexOf('```json'), end: TEXT.length };

describe('JsonBlock', () => {
  it('keeps the text verbatim and highlights the extracted block under its label', () => {
    const w = mount(JsonBlock, { props: { text: TEXT, highlight: FENCE } });
    const pre = w.get('pre');
    expect(pre.classes()).toEqual(expect.arrayContaining(['font-mono', 'whitespace-pre-wrap']));
    const block = w.get('[data-testid="json-highlight"]');
    expect(block.text()).toBe('extracted```json\n{"duplicates": []}\n```');
    expect(block.get('[aria-hidden="true"]').text()).toBe('extracted');
    expect(pre.text().startsWith('I checked invoices.csv')).toBe(true);
  });

  it('dims the blocks the scorer did not use', () => {
    const text = 'a ```json\n{}\n``` b ```json\n{"x":1}\n```';
    const w = mount(JsonBlock, {
      props: { text, ignored: [{ start: 2, end: 16 }], highlight: { start: 19, end: text.length } },
    });
    expect(w.findAll('[data-testid="json-ignored"]')).toHaveLength(1);
    expect(w.get('[data-testid="json-ignored"]').classes()).toContain('opacity-50');
    expect(w.get('[data-testid="json-ignored"]').text()).toContain('ignored');
  });

  it('underlines the character where parsing stopped', () => {
    const text = '```json\n{"duplicates": [1,]}\n```';
    const at = text.indexOf(']');
    const w = mount(JsonBlock, {
      props: { text, highlight: { start: 0, end: text.length }, errorAt: at },
    });
    const mark = w.get('[data-testid="json-error"]');
    expect(mark.text()).toBe(']');
    expect(mark.classes()).toEqual(expect.arrayContaining(['decoration-wavy', 'text-fail-text']));
  });

  it('pretty-prints a value', () => {
    const w = mount(JsonBlock, { props: { value: { duplicates: [['INV-1042', 'INV-1107']] } } });
    expect(w.get('pre').text()).toBe(
      JSON.stringify({ duplicates: [['INV-1042', 'INV-1107']] }, null, 2),
    );
  });
});
