/**
 * Test helpers for the skill and document specs: zips and PDFs built in
 * memory, a SKILL.md with the given front matter, uploaded files as multer
 * hands them over, configurations that reference resources, stand-ins for
 * the ConfigService and PinoLogger the app provides, and a Nest app with
 * both modules. The name ends in `-spec.ts`, so the build leaves it out,
 * and not in `.spec.ts`, so vitest does not run it as a test file.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HttpException, type DynamicModule, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { expect } from 'vitest';
import { ZipFile } from 'yazl';
import { sha } from '../../../test/support/seed.js';
import type { Env } from '../../config/env.js';
import { DB } from '../../database/db.provider.js';
import { configurations, configurationVersions } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { DocumentsModule } from '../documents/documents.module.js';
import type { UploadedFileRef } from './multipart-upload.js';
import { SkillsModule } from './skills.module.js';

/** A PinoLogger that drops everything. */
export const silentLogger = {
  setContext: () => {},
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
} as unknown as PinoLogger;

/** The env values the resource services read, with DATA_DIR at `dataDir`. */
export const testEnv = (dataDir: string): Partial<Env> => ({
  DATA_DIR: dataDir,
  SKILL_UPLOAD_TTL_S: 1800,
});

/** A ConfigService over `values`. */
export function configOf(values: Partial<Env>): ConfigService<Env, true> {
  return { get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>;
}

export interface ZipItem {
  path: string;
  content?: string | Buffer;
  /** Unix mode, file type bits included (0o120777 makes a link). */
  mode?: number;
  folder?: boolean;
  compress?: boolean;
}

export async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A zip of `items`, in order. */
export function buildZip(items: ZipItem[]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const item of items) {
    if (item.folder) zip.addEmptyDirectory(item.path, item.mode ? { mode: item.mode } : {});
    else {
      zip.addBuffer(Buffer.from(item.content ?? `content of ${item.path}\n`), item.path, {
        compress: item.compress ?? true,
        ...(item.mode ? { mode: item.mode } : {}),
      });
    }
  }
  zip.end();
  return collect(zip.outputStream as Readable);
}

/** SKILL.md with front matter `fields` (a null value leaves the key out) and a short body. */
export function skillMd(
  fields: { name?: string | null; version?: string | null; description?: string | null } = {},
  body = '# Invoice method\n\nMatch every invoice to its purchase order.\n',
): string {
  const values = {
    name: 'invoice-method',
    version: '1.0.0',
    description: 'Method for reconciling vendor invoices',
    ...fields,
  };
  const lines = Object.entries(values).flatMap(([key, value]) =>
    value === null ? [] : [`${key}: ${value}`],
  );
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

/** The invoice-method sample skill: SKILL.md, a script, a CSV and a small binary. */
export function invoiceMethodZip(
  fields: Parameters<typeof skillMd>[0] = {},
  extra: ZipItem[] = [],
): Promise<Buffer> {
  return buildZip([
    { path: 'SKILL.md', content: skillMd(fields) },
    { path: 'examples/', folder: true },
    { path: 'examples/reconcile.py', content: 'print("reconcile")\n' },
    { path: 'checklist.csv', content: 'column,required\ninvoice_no,yes\namount,yes\n' },
    { path: 'logo.bin', content: Buffer.from([0x89, 0x00, 0xff, 0x10, 0x00]) },
    ...extra,
  ]);
}

/** The resources one configuration version references. */
export interface VersionRefs {
  skillIds?: string[];
  documentIds?: string[];
}

/** Configuration `name` with one version per entry of `versions`; the last is latest. Returns its id. */
export function seedConfiguration(
  db: AppDb,
  name: string,
  versions: VersionRefs[],
): Promise<string> {
  return db.transaction(async (tx) => {
    const [config] = await tx
      .insert(configurations)
      .values({ name, latestVersion: versions.length })
      .returning();
    for (const [i, refs] of versions.entries()) {
      await tx.insert(configurationVersions).values({
        configurationId: config!.id,
        version: i + 1,
        model: 'openai/gpt-6.1-sol',
        provider: 'nous',
        toolsets: ['file', 'terminal'],
        skillIds: refs.skillIds ?? [],
        documentIds: refs.documentIds ?? [],
        maxTurns: 30,
        timeBudgetS: 600,
        configHash: sha(`${name}:${i}`),
      });
    }
    return config!.id;
  });
}

/** A file as multer hands it to a handler: on disk in its own scratch directory, with the browser's name. */
export async function uploadedFile(
  store: BlobStore,
  content: Buffer | string,
  originalname: string,
  mimetype = 'application/octet-stream',
): Promise<UploadedFileRef> {
  const destination = await store.tmpDir('upload');
  const path = join(destination, 'file');
  await writeFile(path, content);
  return {
    fieldname: 'file',
    originalname,
    encoding: '7bit',
    mimetype,
    size: Buffer.byteLength(content),
    destination,
    filename: 'file',
    path,
    buffer: Buffer.alloc(0),
    stream: Readable.from([]),
  };
}

/** The HTTP status and body a rejected service call would answer with. */
export async function httpFailure(
  promise: Promise<unknown>,
): Promise<{ status: number; body: unknown }> {
  const err: unknown = await promise.then(
    () => new Error('expected a failure'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  const http = err as HttpException;
  return { status: http.getStatus(), body: http.getResponse() };
}

/**
 * A small classic PDF with `pages` pages. The page tree root carries a
 * nested /Resources dictionary with its own /Count, and an outline has
 * /Count too: neither may be read as the page count.
 */
export function classicPdf(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${10 + i} 0 R`).join(' ');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>\nendobj',
    `2 0 obj\n<< /Type /Pages /Resources << /Font << /F1 4 0 R >> /Count 99 >> /Kids [${kids}] /Count ${pages} >>\nendobj`,
    '3 0 obj\n<< /Type /Outlines /Count 42 >>\nendobj',
    ...Array.from(
      { length: pages },
      (_, i) => `${10 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj`,
    ),
  ];
  return Buffer.from(
    `%PDF-1.4\n${objects.join('\n')}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    'latin1',
  );
}

/** The app stand-ins as one global module: ConfigService over `env`, a silent PinoLogger, and DB. */
export function testInfraModule(env: Partial<Env>, db: AppDb): DynamicModule {
  return {
    module: TestInfraModule,
    global: true,
    providers: [
      { provide: ConfigService, useValue: configOf(env) },
      { provide: PinoLogger, useValue: silentLogger },
      { provide: DB, useValue: db },
    ],
    exports: [ConfigService, PinoLogger, DB],
  };
}

class TestInfraModule {}

/** SkillsModule and DocumentsModule mounted under /api as AppModule would, over `db` and `dataDir`. */
export async function startResourcesApp(db: AppDb, dataDir: string): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [testInfraModule(testEnv(dataDir), db), SkillsModule, DocumentsModule],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

/** A supertest parser that keeps a binary response body as a Buffer (`.buffer(true).parse(binaryBody)`). */
export function binaryBody(
  res: unknown,
  callback: (err: Error | null, body: Buffer) => void,
): void {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
  stream.on('error', (err: Error) => callback(err, Buffer.alloc(0)));
}
