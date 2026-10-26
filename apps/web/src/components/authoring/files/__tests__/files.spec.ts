/**
 * FileDropZone and the file lists (Components 5): the drop zone's states (idle, drag-over,
 * uploading with Cancel, refused over 25 MB), workspace files as the agent sees them with
 * folders, notes, Rename and Delete that asks first, and the Files tab grouped by who sees
 * each file, a verifier script read-only.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { DraftFileView } from '@/api/types/authoring';
import FileDropZone from '../FileDropZone.vue';
import TaskFileTree from '../TaskFileTree.vue';
import TaskFolderTable from '../TaskFolderTable.vue';
import { fileView } from '@/api/drafts-fixture-tasks';

const file = (
  path: string,
  kind: DraftFileView['kind'],
  typeLabel = 'Text · 3 lines',
  size = 4300,
): DraftFileView => fileView(path, kind, size, typeLabel);

describe('FileDropZone', () => {
  it('reads the board when idle and when something is dragged over it', async () => {
    const w = mount(FileDropZone, { props: { target: 'workspace files' } });
    const box = w.get('[role="button"]');
    expect(box.text()).toContain('Drop files or a folder, or browse');
    expect(box.text()).toContain('Up to 25 MB per file');
    await box.trigger('dragover');
    expect(box.text()).toContain('Drop to add to workspace files');
    expect(box.attributes('data-over')).toBe('true');
  });

  it('shows each upload with its progress and Cancel', async () => {
    const upload = {
      id: 3,
      name: 'ledger.csv',
      target: '/workspace/ledger.csv',
      kind: 'fixture' as const,
      loaded: 9318,
      total: 23142,
      controller: new AbortController(),
    };
    const w = mount(FileDropZone, { props: { target: 'workspace files', uploads: [upload] } });
    const row = w.get('[data-testid="upload-row"]');
    expect(row.text()).toContain('/workspace/ledger.csv');
    expect(row.text()).toContain('9.1 of 22.6 KB');
    await row.get('button').trigger('click');
    expect(w.emitted('cancel')?.[0]).toEqual([3]);
  });

  it('says a file over 25 MB was not added', () => {
    const w = mount(FileDropZone, {
      props: {
        target: 'workspace files',
        rejected: [
          {
            name: 'ledger-2025.parquet',
            kind: 'fixture',
            sizeBytes: 32715571,
            reason: 'The limit is 25 MB per file.',
          },
        ],
      },
    });
    expect(w.get('[data-testid="upload-rejected"]').text()).toContain(
      'ledger-2025.parquet is 31.2 MB. The limit is 25 MB per file.',
    );
    expect(w.get('[data-testid="upload-rejected"]').text()).toContain('The file was not added.');
  });

  it('says a refusal the API kept is over 25 MB, its size unknown (Phase 5b #11)', async () => {
    const w = mount(FileDropZone, {
      props: {
        target: 'workspace files',
        rejected: [
          {
            name: 'ledger-2025.parquet',
            kind: 'fixture',
            sizeBytes: null,
            reason: 'The limit is 25 MB per file.',
            path: 'fixtures/ledger-2025.parquet',
          },
        ],
      },
    });
    const row = w.get('[data-testid="upload-rejected"]');
    expect(row.text().replace(/\s+/g, ' ')).toContain(
      'ledger-2025.parquet is over 25 MB. The file was not added.',
    );
    await row.get('button[aria-label="Dismiss ledger-2025.parquet"]').trigger('click');
    expect(w.emitted('dismiss')?.[0]).toEqual(['ledger-2025.parquet']);
  });
});

describe('TaskFileTree', () => {
  const files = [
    file('fixtures/invoices.csv', 'fixture', 'CSV · 48 rows · 8 columns'),
    file('fixtures/docs/payment-terms.pdf', 'fixture', 'PDF · 2 pages', 98304),
    file('fixtures/notes.txt', 'fixture'),
  ];

  it('lists files as the agent sees them, with folders and notes', () => {
    const w = mount(TaskFileTree, {
      props: {
        mode: 'workspace',
        files,
        folder: 'fixtures',
        notes: {
          'fixtures/notes.txt':
            '`fixtures/notes.txt` contains `99760.52`, the reference value at `total_due`.',
        },
      },
    });
    const text = w.text();
    expect(text).toContain('/workspace/invoices.csv');
    expect(text).toContain('▾ /workspace/docs/');
    expect(text).toContain(
      'Files under docs/ can collide with configuration documents, which are placed at /workspace/docs/.',
    );
    expect(text).toContain('fixtures/notes.txt contains 99760.52');
    const csv = w.get('[data-path="fixtures/invoices.csv"]');
    expect(csv.findAll('button').map((b) => b.text())).toEqual([
      'Preview',
      'Replace',
      'Rename',
      'Delete',
    ]);
  });

  it('renames in place and asks before deleting', async () => {
    const w = mount(TaskFileTree, {
      props: { mode: 'workspace', files, folder: 'fixtures' },
      attachTo: document.body,
    });
    const row = () => w.get('[data-path="fixtures/notes.txt"]');
    await row()
      .findAll('button')
      .find((b) => b.text() === 'Rename')!
      .trigger('click');
    await row().get('input').setValue('memo.txt');
    await row().get('input').trigger('keydown', { key: 'Enter' });
    expect(w.emitted('rename')?.[0]).toEqual(['fixtures/notes.txt', 'fixtures/memo.txt']);
    await row()
      .findAll('button')
      .find((b) => b.text() === 'Delete')!
      .trigger('click');
    expect(row().text()).toContain('Delete /workspace/notes.txt?');
    await row()
      .findAll('button')
      .find((b) => b.text() === 'Delete')!
      .trigger('click');
    expect(w.emitted('delete')?.[0]).toEqual(['fixtures/notes.txt']);
    w.unmount();
  });

  it('says when there are no files', () => {
    expect(
      mount(TaskFileTree, { props: { mode: 'workspace', files: [], folder: 'fixtures' } }).text(),
    ).toContain('No workspace files. The agent starts with an empty workspace.');
    expect(
      mount(TaskFileTree, { props: { mode: 'expected', files: [], folder: 'expected' } }).text(),
    ).toContain('No expected files yet. Add the files a correct agent would leave.');
  });
});

describe('TaskFolderTable', () => {
  const all = [
    file('prompt.md', 'prompt', 'Markdown', 363),
    file('fixtures/invoices.csv', 'fixture', 'CSV', 4300),
    file('reference.json', 'reference', 'JSON', 13),
    file('task.yaml', 'task_yaml', 'YAML', 382),
    file('expected/summary.csv', 'expected', 'CSV', 307),
    file('verify/check_summary.py', 'verifier', 'Python', 1229),
    file('README.md', 'other', 'Text', 612),
  ];

  it('groups the folder by who sees each file', () => {
    const w = mount(TaskFolderTable, { props: { files: all } });
    expect(w.text()).toContain('Visible to the agent');
    expect(w.text()).toContain('Hidden from the agent');
    expect(w.text()).toContain('Other files');
    // Chip and detail sit in a flex row with a gap.
    expect(w.get('[data-path="prompt.md"]').text()).toContain('Agent sees·\u00a0as task.txt');
    expect(w.get('[data-path="reference.json"]').text()).toContain('Hidden·\u00a0checks only');
    expect(w.get('[data-path="verify/check_summary.py"]').text()).toContain('runs in the worker');
    expect(w.get('[data-path="verify/check_summary.py"]').text()).toContain('edit on disk');
    expect(
      w
        .get('[data-path="verify/check_summary.py"]')
        .findAll('button')
        .map((b) => b.text()),
    ).toEqual(['View', 'Copy path']);
    expect(w.get('[data-path="README.md"]').text()).toContain(
      'Not used by the platform · kept as is',
    );
    expect(w.get('[data-testid="folder-total"]').text()).toBe('7 files · 7 KB');
  });

  it('opens a script read-only and sends Edit in form and the task.yaml tab', async () => {
    const w = mount(TaskFolderTable, {
      props: {
        files: all,
        sources: { 'verify/check_summary.py': { text: 'print(1)\n', error: null } },
      },
    });
    await w.get('[data-path="verify/check_summary.py"]').findAll('button')[0]!.trigger('click');
    expect(w.emitted('view')?.[0]).toEqual(['verify/check_summary.py']);
    expect(w.get('[data-testid="script-source"]').text()).toContain('print(1)');
    await w.get('[data-path="task.yaml"] button').trigger('click');
    expect(w.emitted('openYaml')).toHaveLength(1);
    await w.get('[data-path="prompt.md"] button').trigger('click');
    expect(w.emitted('editInForm')).toHaveLength(1);
  });

  it('shows a text too large to edit as a read-only other file (Phase 5b #18)', () => {
    const big = {
      ...file('rubrics/method.md', 'other', 'Text · 18,204 lines', 1_468_006),
      tooLargeToEdit: true,
    };
    const w = mount(TaskFolderTable, { props: { files: [...all, big] } });
    const row = w.get('[data-path="rubrics/method.md"]');
    expect(row.get('[data-testid="read-only"]').text()).toBe('read-only');
    expect(row.text()).toContain(
      'Over 1 MiB of text, too large to edit here · read-only, kept as is',
    );
    expect(row.findAll('button').map((b) => b.text())).toEqual(['Copy path']);
  });
});
