import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MAX_SKILL_MD_BYTES, readSkillMetadata, splitFrontMatter } from './front-matter.js';

/** SKILL.md of the invoice-method fixture (apps/web/src/fixtures/resources.ts). */
const DESCRIPTION =
  'Method for reconciling vendor invoices: always check credit notes, duplicates and partial payments before totalling';
const FRONT_MATTER = `name: invoice-method
version: 1.0.0
description: ${DESCRIPTION}`;
const BODY = `# Invoice method

Before computing any total from an invoice export, work through these checks in order.
`;
const SKILL_MD = `---\n${FRONT_MATTER}\n---\n\n${BODY}`;

describe('splitFrontMatter', () => {
  it('splits the fixture SKILL.md into its verbatim front matter and body', () => {
    expect(splitFrontMatter(SKILL_MD)).toEqual({ frontMatter: FRONT_MATTER, body: BODY });
  });

  it('accepts a BOM and CRLF line ends, as Hermes does', () => {
    const crlf = `﻿${SKILL_MD.replace(/\n/g, '\r\n')}`;
    const split = splitFrontMatter(crlf);
    expect(split?.frontMatter).toBe(FRONT_MATTER.replace(/\n/g, '\r\n'));
    expect(split?.body).toBe(BODY.replace(/\n/g, '\r\n'));
  });

  it('finds an empty block, and no block when a fence is missing', () => {
    expect(splitFrontMatter('---\n---\n# Body\n')).toEqual({ frontMatter: '', body: '# Body\n' });
    expect(splitFrontMatter('# Just markdown\n')).toBeNull();
    expect(splitFrontMatter('---\nname: x\n')).toBeNull();
    // Hermes needs a newline after the closing fence too.
    expect(splitFrontMatter('---\nname: x\n---')).toBeNull();
    expect(splitFrontMatter('--- not a fence\nname: x\n---\n')).toBeNull();
  });
});

describe('readSkillMetadata', () => {
  it('reads name, version and description', () => {
    expect(readSkillMetadata(SKILL_MD)).toEqual({
      name: { value: 'invoice-method', ok: true },
      version: { value: '1.0.0', ok: true },
      description: { value: DESCRIPTION, ok: true },
      problems: [],
    });
  });

  it('falls back to key: value lines, as Hermes does, when the block is not valid YAML', () => {
    // The fixture's description has a second ": ", which YAML refuses.
    expect(() => parse(FRONT_MATTER)).toThrow();
    expect(readSkillMetadata(SKILL_MD).description).toEqual({ value: DESCRIPTION, ok: true });
    // Duplicate keys are invalid YAML too (ruamel refuses them); Hermes's line split keeps the last.
    const twice = readSkillMetadata('---\nname: a\nname: b\nversion: 1\ndescription: d\n---\n');
    expect(twice.name).toEqual({ value: 'b', ok: true });
    const unclosed = readSkillMetadata('---\nname: [unclosed\nversion: 1\ndescription: d\n---\n');
    expect(unclosed.problems.map((p) => p.title)).toEqual(['Name [unclosed is not allowed.']);
  });

  it('reads bytes as strict UTF-8', () => {
    expect(readSkillMetadata(Buffer.from(SKILL_MD)).problems).toEqual([]);
    expect(readSkillMetadata(Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe])).problems).toEqual([
      { title: 'SKILL.md is not UTF-8 text.', detail: 'Save SKILL.md as UTF-8.' },
    ]);
  });

  it('words missing fields like the upload dialog fixtures', () => {
    const result = readSkillMetadata('---\nname: invoice-method\n---\n# x\n');
    expect(result.version).toEqual({ value: null, ok: false });
    expect(result.problems).toEqual([
      { title: 'No version in metadata.', detail: 'Add version: to the SKILL.md front matter.' },
      {
        title: 'No description in metadata.',
        detail: 'Add description: to the SKILL.md front matter.',
      },
    ]);
    expect(readSkillMetadata('---\nversion: 1\ndescription: d\n---\n').problems).toEqual([
      { title: 'No name in metadata.', detail: 'Add name: to the SKILL.md front matter.' },
    ]);
  });

  it('keeps a version as written and accepts folded descriptions', () => {
    const result = readSkillMetadata(
      '---\nname: invoice-method\nversion: 1.0\ndescription: >-\n  Two\n  lines\nmetadata:\n  hermes: { tags: [a] }\n---\n',
    );
    expect(result.version).toEqual({ value: '1.0', ok: true });
    expect(result.description).toEqual({ value: 'Two lines', ok: true });
    expect(result.problems).toEqual([]);
  });

  it('refuses names Hermes would read differently or the skills table refuses', () => {
    expect(readSkillMetadata('---\nname: yes\nversion: 1\ndescription: d\n---\n').name).toEqual({
      value: 'yes',
      ok: false,
    });
    expect(
      readSkillMetadata('---\nname: 2024\nversion: 1\ndescription: d\n---\n').problems,
    ).toEqual([
      {
        title: 'Name 2024 is not text.',
        detail: 'Quote it in the front matter, for example name: "2024".',
      },
    ]);
    const spaced = readSkillMetadata(
      '---\nname: Invoice Method\nversion: 1\ndescription: d\n---\n',
    );
    expect(spaced.name).toEqual({ value: 'Invoice Method', ok: false });
    expect(spaced.problems[0]?.title).toBe('Name Invoice Method is not allowed.');
    expect(
      readSkillMetadata(`---\nname: ${'a'.repeat(65)}\nversion: 1\ndescription: d\n---\n`).name.ok,
    ).toBe(false);
  });

  it('refuses odd versions and over-long descriptions', () => {
    const odd = readSkillMetadata('---\nname: x\nversion: 1.0 beta\ndescription: d\n---\n');
    expect(odd.version).toEqual({ value: '1.0 beta', ok: false });
    expect(odd.problems[0]?.title).toBe('Version 1.0 beta is not allowed.');
    const long = readSkillMetadata(
      `---\nname: x\nversion: 1\ndescription: ${'d'.repeat(1025)}\n---\n`,
    );
    expect(long.problems).toEqual([
      {
        title: 'Description too long.',
        detail: 'It has 1025 characters; Hermes reads at most 1024.',
      },
    ]);
  });

  it('explains a missing block and a block that is not a mapping', () => {
    expect(readSkillMetadata('# Invoice method\n').problems).toEqual([
      {
        title: 'No front matter in SKILL.md.',
        detail:
          'Start SKILL.md with a block between --- lines holding name, version and description.',
      },
    ]);
    expect(readSkillMetadata('---\n- a\n- b\n---\n').problems[0]?.title).toBe(
      'SKILL.md front matter is not a mapping.',
    );
  });

  it('refuses a SKILL.md over 1 MB without parsing it', () => {
    const huge = `---\n${FRONT_MATTER}\n---\n${'x'.repeat(MAX_SKILL_MD_BYTES)}`;
    expect(readSkillMetadata(huge).problems).toEqual([
      {
        title: 'SKILL.md too large.',
        detail: 'It is larger than 1 MB. Move long material into other files of the skill.',
      },
    ]);
  });
});
