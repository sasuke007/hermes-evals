/**
 * A suite version as a .zip (plan 4.6, SA.10 "Download .zip"): every file
 * the version holds, streamed from its blobs while the zip is sent, named
 * `<folder>-v<n>.zip` (suiteVersionZipName). The zip holds one folder named
 * after the suite folder, as "Compress" on a folder makes it, so importing
 * it back (POST /suites/import/validate) reads the same suite.
 *
 * The database keeps what the loader read, not the folder: task.yaml,
 * prompt.md and reference.json come back byte for byte (draft-folder.ts
 * baseTaskFolder), every task file from its blob, and suite.yaml, whose
 * text is not stored, is written from the version's name, label,
 * description and task order in the canonical style. Files the loader never
 * read (a README) are not in the database and not in the zip.
 */
import type { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { suiteVersionZipName } from '@hermes-evals/shared';
import type { AppDb } from '../../database/types.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { notFound } from '../http-errors.js';
import { SUITE_YAML } from '../loader/limits.js';
import { baseTaskFolder, folderFiles } from './draft-folder.js';
import { storedTasks, suiteVersion } from './draft-store.js';
import { renderSuiteYaml } from './suite-yaml.js';

export interface VersionZip {
  filename: string;
  stream: Readable;
  /** Each entry's path in the zip, in order; for logs and tests. */
  entries: string[];
}

export async function versionZip(
  db: AppDb,
  blobs: Pick<BlobStore, 'read' | 'stream'>,
  folder: string,
  versionNumber: number,
): Promise<VersionZip> {
  const suite = await suiteVersion(db, folder, versionNumber);
  if (!suite) throw notFound(`version ${versionNumber} of ${folder}`);
  const tasks = await storedTasks(db, suite);
  const folders = await Promise.all(
    tasks.map(
      async (t) =>
        (await baseTaskFolder(t.task, t.files, t.roots, (sha) => blobs.read(sha))).folder,
    ),
  );
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  zip.on('error', (err: Error) => output.destroy(err));
  const options = { mtime: suite.loadedAt, mode: 0o100644 };
  const entries: string[] = [];
  const suiteYaml = renderSuiteYaml(null, {
    name: suite.name,
    versionLabel: suite.versionLabel,
    description: suite.description,
    tasks: tasks.map((t) => t.task.key),
  });
  entries.push(`${folder}/${SUITE_YAML}`);
  zip.addBuffer(Buffer.from(suiteYaml, 'utf8'), entries.at(-1)!, options);
  for (const task of folders) {
    for (const file of folderFiles(task)) {
      const path = `${folder}/${task.key}/${file.path}`;
      entries.push(path);
      if (file.text !== null) {
        zip.addBuffer(Buffer.from(file.text, 'utf8'), path, options);
        continue;
      }
      const { sha256, size } = file.ref;
      zip.addReadStreamLazy(path, { ...options, size }, (callback) => {
        try {
          callback(null, blobs.stream(sha256));
        } catch (err) {
          callback(err as Error, null as unknown as NodeJS.ReadableStream);
        }
      });
    }
  }
  zip.end();
  return { filename: suiteVersionZipName(folder, versionNumber), stream: output, entries };
}
