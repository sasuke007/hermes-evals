/**
 * The knowledge that knowledge-v1's arms ship (plan 18.3, Phase 6b R6): the
 * reason-code table the generator owns (samples/skills/bx7-format/codes.md),
 * and the documents arm's files (samples/documents/knowledge-v1/), which are
 * the skills' own text: each SKILL.md without its front matter, and every
 * other skill file byte for byte. The skills themselves (SKILL.md, bx7.py,
 * the template, the BX-6 decoy) are written by hand.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODES, type CodeClass } from './statements.ts';

export const SKILLS_DIR = 'samples/skills';
export const DOCUMENTS_DIR = 'samples/documents/knowledge-v1';
export const CODES_PATH = `${SKILLS_DIR}/bx7-format/codes.md`;

/**
 * The phrases each knowledge file holds and nothing else does: the mock
 * scripts match on them (scripts/phase6b-knowledge-v1-mock-scripts.json).
 */
export const MARKERS = {
  /** bx7-format's SKILL.md body (so bx7-spec.md too), never its description. */
  bx7: 'kv1-bx7-format',
  /** codes.md only: SKILL.md points to it but does not hold it. */
  codes: 'kv1-bx7-codes',
  /** house-style's SKILL.md body. */
  house: 'kv1-house-style',
  /** The house style's template file only. */
  template: 'kv1-summary-template',
  /** The BX-6 decoy's SKILL.md body. */
  bx6: 'kv1-bx6-format',
} as const;

/** Each document of the documents arm and the skill file it is the text of. */
export const DOCUMENTS: ReadonlyArray<{ doc: string; skill: string; frontMatter: boolean }> = [
  { doc: 'bx7-spec.md', skill: 'bx7-format/SKILL.md', frontMatter: true },
  { doc: 'codes.md', skill: 'bx7-format/codes.md', frontMatter: false },
  { doc: 'bx7.py', skill: 'bx7-format/scripts/bx7.py', frontMatter: false },
  { doc: 'house-style.md', skill: 'house-style/SKILL.md', frontMatter: true },
  {
    doc: 'summary-template.md',
    skill: 'house-style/templates/summary-template.md',
    frontMatter: false,
  },
  { doc: 'bx6-spec.md', skill: 'bx6-format/SKILL.md', frontMatter: true },
];

const CLASSES: ReadonlyArray<[CodeClass, string]> = [
  ['card', 'paid or withdrawn with a card of the account.'],
  ['fee', 'a charge the bank makes for its own services.'],
  ['refund', 'money the bank pays back, such as a fee charged in error.'],
  ['interest', 'interest the bank pays on the balance or charges on an overdraft.'],
  ['payment', 'money paid to someone else: a supplier, an employee, a direct debit.'],
  ['receipt', 'money received from someone else.'],
  ['transfer', "money moved between the company's own accounts."],
  ['tax', 'tax the bank withholds and pays on.'],
  ['correction', 'the bank correcting a booking error of its own.'],
];

/** A Markdown table as prettier prints it: every column padded to its widest cell. */
export function table(header: readonly string[], rows: readonly string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const row = (cells: readonly string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  return [row(header), row(widths.map((w) => '-'.repeat(w))), ...rows.map(row)].join('\n');
}

export function codesMd(): string {
  return [
    '# BX-7 reason codes',
    '',
    `Code table reference: ${MARKERS.codes}, revision 3.`,
    '',
    'Every reason code a BX-7 movement or reversal can carry, with its name and its class. The class says what kind of movement a code is; the letter of a code does not. A reversal carries the code of the movement it reverses.',
    '',
    table(
      ['Code', 'Name', 'Class'],
      CODES.map((c) => [c.code, c.name, c.cls]),
    ),
    '',
    '## Classes',
    '',
    ...CLASSES.map(([cls, what]) => `- \`${cls}\`: ${what}`),
    '',
  ].join('\n');
}

/** SKILL.md without its front matter, as Hermes's reader splits it (no leading blank lines). */
export function skillBody(text: string): string {
  const match = /^---[ \t]*\n[\s\S]*?\n---[ \t]*\n/.exec(text);
  if (!match) throw new Error('knowledge-v1 generator: a SKILL.md has no front matter');
  return text.slice(match[0].length).replace(/^(?:[ \t]*\n)+/, '');
}

/**
 * The documents arm's files, by name: read from the skills in `repo`, with
 * codes.md taken from `codes` (what this run writes), so the two never differ.
 */
export function documents(repo: string, codes: string): Map<string, string> {
  return new Map(
    DOCUMENTS.map(({ doc, skill, frontMatter }) => {
      const text =
        skill === 'bx7-format/codes.md'
          ? codes
          : readFileSync(join(repo, SKILLS_DIR, skill), 'utf8');
      return [doc, frontMatter ? skillBody(text) : text];
    }),
  );
}
