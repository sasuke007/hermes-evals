/**
 * The Files tab's rows of a draft task (fileViews): a text the forms edit
 * that a zip held at more than the editor can save back stays a blob of
 * kind `other`, marked `tooLargeToEdit` so it is shown read-only (Phase 5b
 * question 18, settled for Phase 7); nothing else is marked.
 */
import { describe, expect, it } from 'vitest';
import { AUTHORING_LIMITS, DraftFileViewSchema } from '@hermes-evals/shared';
import { sha256Hex } from '../loader/hashing.js';
import { fileViews } from './draft-task-views.js';
import type { DraftFileRef, DraftTaskFolder } from './materialise.js';

const OVER = AUTHORING_LIMITS.draftTextMaxChars + 1;

const JUDGED_YAML = `summary: Judge the note
answer:
  format: fenced_json
verification:
  - key: tone
    type: llm_judge
    primary: true
    params: { rubric: rubrics/tone.md }
`;

const ref = (path: string, kind: DraftFileRef['kind'], size: number): DraftFileRef => ({
  path,
  kind,
  size,
  sha256: sha256Hex(Buffer.from(path)),
});

describe('fileViews', () => {
  it('marks a root text or a rubric held as a blob over the editor limit, and nothing else', async () => {
    const folder: DraftTaskFolder = {
      key: 'judged',
      taskYaml: JUDGED_YAML,
      prompt: null,
      reference: '{ "ok": true }\n',
      rubrics: {},
      files: [
        ref('prompt.md', 'other', OVER),
        ref('rubrics/tone.md', 'other', OVER),
        // Not UTF-8, so a blob, but small: not "too large".
        ref('reference.json', 'other', 12),
        // Large files that are no text the forms edit.
        ref('fixtures/ledger.csv', 'fixture', OVER),
        ref('notes.md', 'other', OVER),
      ],
    };
    const views = (await fileViews(folder, async () => Buffer.alloc(0))).map((v) =>
      DraftFileViewSchema.parse(v),
    );
    const marked = Object.fromEntries(views.map((v) => [v.path, v.tooLargeToEdit ?? false]));
    expect(marked).toEqual({
      'task.yaml': false,
      'prompt.md': true,
      // The draft's own text wins over a blob at the same path.
      'reference.json': false,
      'rubrics/tone.md': true,
      'fixtures/ledger.csv': false,
      'notes.md': false,
    });
    expect(views.find((v) => v.path === 'prompt.md')).toMatchObject({
      kind: 'other',
      sizeBytes: OVER,
    });
  });
});
