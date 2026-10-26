/**
 * parseTaskTable: CSV and JSONL files of tasks as the import's upload step
 * reads them (SA.9 step 1), and every refusal it words.
 */
import { describe, expect, it } from 'vitest';
import { TaskTableFileSchema, UploadProblemSchema } from '@hermes-evals/shared';
import { parseTaskTable, type TaskTableParse } from './parsers.js';

const csv = (text: string) => Buffer.from(text, 'utf8');

function parsed(result: TaskTableParse) {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.problems)}`);
  TaskTableFileSchema.parse(result.file);
  return result;
}

function refused(result: TaskTableParse) {
  if (result.ok) throw new Error('expected a refusal');
  for (const problem of result.problems) UploadProblemSchema.parse(problem);
  if (result.file) TaskTableFileSchema.parse(result.file);
  return result;
}

const OVERDUE = `key,question,expected
overdue_fjord,How many overdue invoices does Fjord Software have?,3
overdue_granite,How many overdue invoices does Granite Office have?,2
overdue_over_5000,"How many overdue invoices are over 5,000 EUR?",6
overdue 90,How many invoices are more than 90 days overdue?,1
`;

describe('CSV', () => {
  it('reads the header as columns, with the first three values of each', () => {
    const result = parsed(parseTaskTable('overdue_questions.csv', csv(OVERDUE)));
    expect(result.file).toEqual({
      fileName: 'overdue_questions.csv',
      format: 'csv',
      sizeBytes: Buffer.byteLength(OVERDUE),
      rowCount: 4,
      columns: [
        { name: 'key', samples: ['overdue_fjord', 'overdue_granite', 'overdue_over_5000'] },
        {
          name: 'question',
          samples: [
            'How many overdue invoices does Fjord Software have?',
            'How many overdue invoices does Granite Office have?',
            'How many overdue invoices are over 5,000 EUR?',
          ],
        },
        { name: 'expected', samples: ['3', '2', '6'] },
      ],
    });
    expect(result.rows[3]).toEqual({
      row: 4,
      values: {
        key: 'overdue 90',
        question: 'How many invoices are more than 90 days overdue?',
        expected: '1',
      },
    });
  });

  it('keeps quoted delimiters, doubled quotes and line breaks inside quotes', () => {
    const text = 'key,prompt\r\nq1,"Say ""hi"", then\r\nlist the files."\r\n\r\nq2,plain\r\n';
    const { rows } = parsed(parseTaskTable('q.csv', csv(text)));
    expect(rows).toEqual([
      { row: 1, values: { key: 'q1', prompt: 'Say "hi", then\r\nlist the files.' } },
      { row: 2, values: { key: 'q2', prompt: 'plain' } },
    ]);
  });

  it.each([
    [
      'semicolons',
      'key;prompt;expected\nq1;"a; b";3,5\n',
      { key: 'q1', prompt: 'a; b', expected: '3,5' },
    ],
    ['tabs', 'key\tprompt\nq1\tsay, hi\n', { key: 'q1', prompt: 'say, hi' }],
  ])('reads a header delimited by %s', (_what, text, values) => {
    expect(parsed(parseTaskTable('q.csv', csv(text))).rows).toEqual([{ row: 1, values }]);
  });

  it('drops a UTF-8 byte-order mark and reads UTF-16 with its mark', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv('key,prompt\nq1,Grüße\n')]);
    expect(parsed(parseTaskTable('q.csv', bom)).file.columns[0]!.name).toBe('key');
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('key,prompt\nq1,Grüße\n', 'utf16le'),
    ]);
    expect(parsed(parseTaskTable('q.csv', utf16)).rows[0]!.values.prompt).toBe('Grüße');
  });

  it('keeps a column named __proto__ as a column', () => {
    const { rows } = parsed(parseTaskTable('q.csv', csv('__proto__,prompt\nx,y\n')));
    expect(Object.hasOwn(rows[0]!.values, '__proto__')).toBe(true);
    expect(rows[0]!.values['__proto__']).toBe('x');
  });

  it('refuses a row of another length, one problem per row', () => {
    const result = refused(parseTaskTable('q.csv', csv('key,prompt\nq1,a\nq2,a,b\nq3\n')));
    expect(result.problems.map((p) => p.title)).toEqual([
      'Row 2 has 3 values; the header has 2 columns.',
      'Row 3 has 1 value; the header has 2 columns.',
    ]);
    expect(result.file?.rowCount).toBe(1);
  });

  it('lists at most ten problems', () => {
    const bad = Array.from({ length: 25 }, (_, i) => `q${i},a,extra`).join('\n');
    const { problems } = refused(parseTaskTable('q.csv', csv(`key,prompt\n${bad}\n`)));
    expect(problems).toHaveLength(10);
    expect(problems[9]).toEqual({
      title: '16 more problems.',
      detail: 'Fix the ones above and upload again.',
    });
  });

  it.each([
    ['key,key\na,b\n', 'Column key is named twice.'],
    ['key,,prompt\na,b,c\n', 'Column 2 has no name.'],
    ['key,prompt\nq1,"never closed\n', 'q.csv cannot be read as CSV.'],
    ['key,prompt\n', 'q.csv has no rows.'],
  ])('refuses %j', (text, title) => {
    expect(refused(parseTaskTable('q.csv', csv(text))).problems[0]!.title).toBe(title);
  });
});

describe('JSONL', () => {
  it('takes columns from the keys in order of first appearance, values as JSON', () => {
    const text = [
      '{"key":"q1","question":"How many?","expected":3}',
      '',
      '{"key":"q2","expected":{"total":2.5},"question":"And now?","note":null}\r',
    ].join('\n');
    const result = parsed(parseTaskTable('tasks.jsonl', csv(text)));
    expect(result.file.format).toBe('jsonl');
    expect(result.file.columns).toEqual([
      { name: 'key', samples: ['q1', 'q2'] },
      { name: 'question', samples: ['How many?', 'And now?'] },
      { name: 'expected', samples: ['3', '{"total":2.5}'] },
      { name: 'note', samples: ['null'] },
    ]);
    expect(result.rows).toEqual([
      { row: 1, values: { key: 'q1', question: 'How many?', expected: 3 } },
      { row: 2, values: { key: 'q2', expected: { total: 2.5 }, question: 'And now?', note: null } },
    ]);
  });

  it('refuses each bad line by its line number', () => {
    const text = '{"key":"q1"}\nnot json\n[1,2]\n{"":1}\n{"n":1e999}\n';
    expect(refused(parseTaskTable('t.jsonl', csv(text))).problems.map((p) => p.title)).toEqual([
      'Line 2 is not valid JSON.',
      'Line 3 is not a JSON object.',
      'Line 4 has an empty key.',
      'Line 5 holds a number that is out of range.',
    ]);
  });
});

describe('refusals of the file as a whole', () => {
  it('refuses another format', () => {
    expect(refused(parseTaskTable('questions.xlsx', csv('x'))).problems).toEqual([
      {
        title: 'questions.xlsx: use CSV or JSONL.',
        detail: 'Save the sheet as CSV UTF-8, or write one JSON object per line in a .jsonl file.',
      },
    ]);
  });

  it('refuses more than 5 MB, before reading it', () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    expect(refused(parseTaskTable('big.csv', big)).problems[0]!.title).toBe(
      'big.csv is larger than 5 MB, the limit per import.',
    );
  });

  it('refuses more than 500 rows, with the count', () => {
    const rows = Array.from({ length: 1240 }, (_, i) => `q${i},prompt ${i}`).join('\n');
    const result = refused(parseTaskTable('all_questions.csv', csv(`key,prompt\n${rows}\n`)));
    expect(result.problems).toEqual([
      {
        title: 'all_questions.csv: 1,240 rows. The limit is 500 per import.',
        detail: 'Split the file and import each part.',
      },
    ]);
    expect(result.file?.rowCount).toBe(1240);
  });

  it('refuses text that is not UTF-8', () => {
    const latin1 = Buffer.from('key,prompt\nq1,Gr\xfc\xdfe\n', 'latin1');
    expect(refused(parseTaskTable('q.csv', latin1)).problems[0]!.title).toBe(
      'q.csv is not UTF-8 text.',
    );
    const utf16NoMark = Buffer.from('key,prompt\n', 'utf16le');
    expect(refused(parseTaskTable('q.csv', utf16NoMark)).problems[0]!.title).toBe(
      'q.csv is not UTF-8 text.',
    );
  });
});
