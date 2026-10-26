/**
 * The content rules of a task's home seeds (Phase 6 P1): MEMORY.md and
 * USER.md are read the way Hermes reads them at the start of a trial
 * (tools/memory_tool_store.py at v0.22.4: `_read_raw_checked`,
 * `_parse_entries`, `load_from_disk`), and the loader says when that differs
 * from what the author meant:
 *
 * - not UTF-8: Hermes reads the file as empty, so the seed never reaches the
 *   prompt. An error (schema_invalid), as for prompt.md;
 * - over Hermes's character budget (MEMORY_CHAR_LIMITS, counted as Hermes
 *   counts: the entries joined by the delimiter, in code points): Hermes
 *   still loads it but refuses every memory write. A warning;
 * - not a list of entries separated by MEMORY_ENTRY_DELIMITER (a § on a line
 *   of its own): no entries at all, a § inside an entry, or a Markdown list
 *   with no delimiter, which Hermes reads as one entry. A warning.
 *
 * Warnings (home_seed_format) leave the task valid: the seed is still what a
 * trial starts with, only perhaps not what the author meant.
 */
import { posix } from 'node:path';
import { MEMORY_CHAR_LIMITS, MEMORY_ENTRY_DELIMITER, type LoadIssue } from '@hermes-evals/shared';
import {
  homeSeedEmptyMessage,
  homeSeedListMessage,
  homeSeedNotUtf8Message,
  homeSeedOverLimitMessage,
  homeSeedStraySectionMessage,
} from './messages.js';
import type { StoredTaskFile } from './task-files.js';

/** A Markdown or numbered list item at the start of a line. */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

/** Length in code points, as Python's len() counts a str (not UTF-16 units, not graphemes). */
function charCount(text: string): number {
  let count = 0;
  for (const _codePoint of text) count += 1;
  return count;
}

/**
 * A seed's entries as Hermes parses them: BOM dropped (utf-8-sig), line
 * endings made `\n` (Python's universal newlines), split on the full
 * delimiter, each entry stripped, empty ones dropped, repeats dropped.
 */
export function memoryEntries(text: string): string[] {
  const normal = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const entries = normal
    .split(MEMORY_ENTRY_DELIMITER)
    .map((e) => e.trim())
    .filter((e) => e !== '');
  return [...new Set(entries)];
}

/** The characters Hermes counts against a file's budget. */
export const memoryCharCount = (entries: readonly string[]): number =>
  charCount(entries.join(MEMORY_ENTRY_DELIMITER));

/** Issues of one home seed's content; none for a file that reads as intended. */
export function homeSeedIssues(file: Pick<StoredTaskFile, 'path' | 'content'>): LoadIssue[] {
  const { path } = file;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.content);
  } catch {
    return [
      { severity: 'error', code: 'schema_invalid', path, message: homeSeedNotUtf8Message(path) },
    ];
  }
  const warn = (message: string): LoadIssue => ({
    severity: 'warning',
    code: 'home_seed_format',
    path,
    message,
  });
  const entries = memoryEntries(text);
  if (entries.length === 0) return [warn(homeSeedEmptyMessage(path))];

  const issues: LoadIssue[] = [];
  const name = posix.basename(path);
  const limit =
    name in MEMORY_CHAR_LIMITS ? MEMORY_CHAR_LIMITS[name as keyof typeof MEMORY_CHAR_LIMITS] : null;
  const chars = memoryCharCount(entries);
  if (limit !== null && chars > limit) {
    const drift = entries.some((e) => charCount(e) > limit);
    issues.push(warn(homeSeedOverLimitMessage(path, chars, limit, drift)));
  }
  const stray = entries.findIndex((e) => e.includes('§'));
  if (stray >= 0) issues.push(warn(homeSeedStraySectionMessage(path, stray + 1)));
  if (entries.length === 1) {
    const items = entries[0]!.split('\n').filter((line) => LIST_ITEM.test(line)).length;
    if (items >= 2) issues.push(warn(homeSeedListMessage(path, items)));
  }
  return issues;
}
