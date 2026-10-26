/**
 * /api/docs covers every route with the shared zod contracts, and its
 * "Try it out" passes RequestedWithGuard. The controllers are scanned with
 * stand-in services: the document needs their metadata, not a database.
 */
import { runInNewContext } from 'node:vm';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusalOf } from '../common/requested-with.guard.js';
import { ConfigurationsController } from '../configurations/configurations.controller.js';
import { ExperimentsCommandsController } from '../experiments/commands/experiments-commands.controller.js';
import { ComparisonController } from '../experiments/comparison/comparison.controller.js';
import { ExperimentsReadController } from '../experiments/experiments-read.controller.js';
import { HealthController } from '../health/health.controller.js';
import { ProvidersController } from '../providers/providers.controller.js';
import { CountsController } from '../resources/counts/counts.controller.js';
import { DocumentsController } from '../resources/documents/documents.controller.js';
import { McpController } from '../resources/mcp/mcp.controller.js';
import { SecretsController } from '../resources/secrets/secrets.controller.js';
import { SkillsController } from '../resources/skills/skills.controller.js';
import { RunsCommandsController } from '../runs/commands/runs-commands.controller.js';
import { RunsReadController } from '../runs/views/runs-read.controller.js';
import { DraftTasksController } from '../suites/drafts/draft-tasks.controller.js';
import { SuiteDraftsController } from '../suites/drafts/drafts.controller.js';
import { SuiteImportController } from '../suites/import/suite-import.controller.js';
import { DraftJobsController } from '../suites/save/draft-jobs.controller.js';
import { SuitesController } from '../suites/suites.controller.js';
import { SystemEventsController } from '../system/events/system-events.controller.js';
import { SystemController } from '../system/system.controller.js';
import { buildApiDocument, swaggerRequestInterceptor } from './document.js';
import { REQUEST_SCHEMAS, RESPONSE_SCHEMAS } from './schemas.js';

/** Every route, as the document must list it. */
const ROUTES: readonly (readonly [string, string])[] = [
  ['get', '/api/health'],
  ['get', '/api/suites'],
  ['post', '/api/suites/reload'],
  ['get', '/api/suites/reload/progress'],
  ['get', '/api/suites/{id}'],
  ['get', '/api/suites/{id}/history'],
  ['get', '/api/suites/{id}/tasks/{key}'],
  ['get', '/api/suites/{id}/tasks/{key}/history'],
  ['get', '/api/suites/{id}/tasks/{key}/diff'],
  ['get', '/api/suites/{id}/tasks/{key}/fixtures/{path}'],
  ['get', '/api/suites/{id}/tasks/{key}/fixtures/{path}/preview'],
  // Suite authoring (Phase 5b): drafts, their tasks and files, the jobs, the imports.
  ['get', '/api/suites/drafts'],
  ['post', '/api/suites/drafts'],
  ['post', '/api/suites/{suite}/draft'],
  ['get', '/api/suites/{suite}/draft'],
  ['patch', '/api/suites/{suite}/draft'],
  ['delete', '/api/suites/{suite}/draft'],
  ['get', '/api/suites/{suite}/draft/review'],
  ['post', '/api/suites/{suite}/draft/save'],
  ['post', '/api/suites/{suite}/draft/rebase'],
  ['get', '/api/suites/{suite}/versions/{n}/zip'],
  ['post', '/api/suites/{suite}/draft/tasks'],
  ['get', '/api/suites/{suite}/draft/tasks/{key}'],
  ['put', '/api/suites/{suite}/draft/tasks/{key}'],
  ['delete', '/api/suites/{suite}/draft/tasks/{key}'],
  ['post', '/api/suites/{suite}/draft/tasks/{key}/revert'],
  ['get', '/api/suites/{suite}/draft/tasks/{key}/readiness'],
  ['post', '/api/suites/{suite}/draft/tasks/{key}/try'],
  ['post', '/api/suites/{suite}/draft/tasks/{key}/self-check'],
  ['get', '/api/suites/{suite}/draft/tasks/{key}/diff'],
  ['post', '/api/suites/{suite}/draft/tasks/{key}/files'],
  ['patch', '/api/suites/{suite}/draft/tasks/{key}/files/{path}'],
  ['delete', '/api/suites/{suite}/draft/tasks/{key}/files/{path}'],
  ['get', '/api/suites/{suite}/draft/tasks/{key}/files/{path}'],
  ['get', '/api/suites/{suite}/draft/tasks/{key}/files/{path}/preview'],
  ['post', '/api/suites/{suite}/draft/import/validate'],
  ['post', '/api/suites/{suite}/draft/import'],
  ['post', '/api/suites/import/validate'],
  ['post', '/api/suites/import'],
  ['get', '/api/resources/counts'],
  ['get', '/api/resources/skills'],
  ['post', '/api/resources/skills'],
  ['post', '/api/resources/skills/validate'],
  ['get', '/api/resources/skills/{id}'],
  ['get', '/api/resources/skills/{id}/files/{path}'],
  ['get', '/api/resources/skills/{id}/zip'],
  ['delete', '/api/resources/skills/{id}'],
  ['get', '/api/resources/documents'],
  ['post', '/api/resources/documents'],
  ['get', '/api/resources/documents/{id}/content'],
  ['delete', '/api/resources/documents/{id}'],
  ['get', '/api/resources/mcp-servers'],
  ['post', '/api/resources/mcp-servers'],
  ['post', '/api/resources/mcp-servers/test'],
  ['put', '/api/resources/mcp-servers/{id}'],
  ['post', '/api/resources/mcp-servers/{id}/test'],
  ['get', '/api/resources/secrets'],
  ['get', '/api/configurations'],
  ['post', '/api/configurations'],
  ['get', '/api/configurations/diff'],
  ['get', '/api/configurations/form-options'],
  ['get', '/api/configurations/new-draft'],
  ['get', '/api/configurations/{id}'],
  ['put', '/api/configurations/{id}'],
  ['get', '/api/configurations/{id}/versions/{version}'],
  ['post', '/api/configurations/{id}/duplicate'],
  ['get', '/api/configurations/{id}/draft'],
  ['get', '/api/system/summary'],
  ['get', '/api/system/workers'],
  ['get', '/api/system/sandbox'],
  ['get', '/api/system/events'],
  ['get', '/api/providers'],
  ['post', '/api/providers/nous/login'],
  ['get', '/api/providers/nous/login'],
  ['delete', '/api/providers/nous/login'],
  ['post', '/api/providers/nous/logout'],
  ['get', '/api/experiments/new-options'],
  ['get', '/api/experiments/estimate'],
  ['post', '/api/experiments'],
  ['get', '/api/experiments'],
  ['get', '/api/experiments/{id}'],
  ['get', '/api/experiments/{id}/events'],
  ['get', '/api/experiments/{id}/comparison'],
  ['post', '/api/experiments/{id}/pause'],
  ['post', '/api/experiments/{id}/resume'],
  ['post', '/api/experiments/{id}/cancel'],
  ['post', '/api/experiments/{id}/retry-failed'],
  ['post', '/api/experiments/{id}/duplicate'],
  ['get', '/api/experiments/{id}/runs'],
  ['post', '/api/experiments/{id}/runs/retry'],
  ['post', '/api/experiments/{id}/runs/rescore'],
  ['get', '/api/runs/{id}'],
  ['get', '/api/runs/{id}/events'],
  ['get', '/api/runs/{id}/attempts/{n}/stderr'],
  ['post', '/api/runs/{id}/rescore'],
  ['post', '/api/runs/{id}/retry'],
  ['post', '/api/runs/{id}/cancel'],
  ['get', '/api/runs/{id}/artifacts/{artifactId}/content'],
  ['get', '/api/runs/{id}/artifacts/{artifactId}/preview'],
];

/** Routes that answer 204 with no body. */
const NO_CONTENT = new Set([
  'delete /api/resources/skills/{id}',
  'delete /api/resources/documents/{id}',
  'delete /api/suites/{suite}/draft',
]);

/** State-changing routes that take no body (RequestedWithGuard still wants a JSON one, `{}`). */
const BODILESS = new Set([
  ...NO_CONTENT,
  'post /api/suites/{suite}/draft',
  'delete /api/suites/{suite}/draft/tasks/{key}',
  'post /api/suites/{suite}/draft/tasks/{key}/revert',
  'post /api/suites/{suite}/draft/tasks/{key}/self-check',
  'delete /api/suites/{suite}/draft/tasks/{key}/files/{path}',
  'post /api/resources/mcp-servers/{id}/test',
  'post /api/configurations/{id}/duplicate',
  'post /api/providers/nous/login',
  'delete /api/providers/nous/login',
  'post /api/providers/nous/logout',
  'post /api/experiments/{id}/pause',
  'post /api/experiments/{id}/cancel',
  'post /api/experiments/{id}/retry-failed',
  'post /api/experiments/{id}/duplicate',
  'post /api/runs/{id}/rescore',
  'post /api/runs/{id}/retry',
  'post /api/runs/{id}/cancel',
]);

interface Operation {
  requestBody?: { content: Record<string, { schema: unknown }> };
  responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
  parameters?: { name: string; in: string }[];
}

let app: INestApplication;
let document: OpenAPIObject;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [
      HealthController,
      SuitesController,
      SkillsController,
      DocumentsController,
      McpController,
      SecretsController,
      CountsController,
      ConfigurationsController,
      SystemController,
      SystemEventsController,
      ProvidersController,
      ExperimentsCommandsController,
      RunsCommandsController,
      ExperimentsReadController,
      ComparisonController,
      RunsReadController,
      SuiteDraftsController,
      DraftTasksController,
      DraftJobsController,
      SuiteImportController,
    ],
  })
    .useMocker(() => ({}))
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  document = buildApiDocument(app);
});

afterAll(async () => {
  await app?.close();
});

const operation = (method: string, path: string): Operation => {
  const item = document.paths[path] as Record<string, Operation> | undefined;
  const op = item?.[method];
  if (!op) throw new Error(`${method.toUpperCase()} ${path} is not documented`);
  return op;
};

/** Every $ref in a value. */
function refsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) refsIn(item, into);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === '$ref' && typeof inner === 'string') into.add(inner);
      else refsIn(inner, into);
    }
  }
  return into;
}

describe('the API document', () => {
  it('lists every route and nothing undocumented', () => {
    const listed = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item as object).map((method) => `${method} ${path}`),
    );
    expect(listed.sort()).toEqual(ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  });

  it('gives every route a success response with a schema', () => {
    for (const [method, path] of ROUTES) {
      const op = operation(method, path);
      if (NO_CONTENT.has(`${method} ${path}`)) {
        const statuses = Object.keys(op.responses).filter((s) => /^2\d\d$/.test(s));
        expect(statuses, `${method} ${path}`).toEqual(['204']);
        expect(op.responses['204']!.content, `${method} ${path}`).toBeUndefined();
        expect(op.responses['default'], `${method} ${path} error body`).toBeTruthy();
        continue;
      }
      const success = Object.entries(op.responses).filter(([status]) => /^2\d\d$/.test(status));
      expect(success, `${method} ${path}`).toHaveLength(1);
      const content = success[0]![1].content ?? {};
      expect(Object.keys(content).length, `${method} ${path} has no content`).toBeGreaterThan(0);
      for (const media of Object.values(content)) expect(media.schema).toBeTruthy();
      expect(op.responses['default'], `${method} ${path} error body`).toBeTruthy();
    }
  });

  it('gives every state-changing route its request body and the 403', () => {
    for (const [method, path] of ROUTES) {
      if (method === 'get') continue;
      const op = operation(method, path);
      expect(op.responses['403'], `${method} ${path}`).toBeTruthy();
      if (BODILESS.has(`${method} ${path}`)) {
        expect(op.requestBody, `${method} ${path}`).toBeUndefined();
        continue;
      }
      const content = op.requestBody?.content ?? {};
      expect(Object.keys(content), `${method} ${path}`).toEqual([
        expect.stringMatching(/^(application\/json|multipart\/form-data)$/),
      ]);
    }
  });

  it('names the shared schemas, and every reference resolves', () => {
    const schemas = document.components?.schemas ?? {};
    for (const name of [...Object.keys(RESPONSE_SCHEMAS), ...Object.keys(REQUEST_SCHEMAS)]) {
      expect(schemas[name], name).toBeTruthy();
      expect(schemas[name]).not.toHaveProperty('$id');
    }
    for (const ref of refsIn(document)) {
      expect(ref).toMatch(/^#\/components\/schemas\//);
      expect(schemas[ref.slice('#/components/schemas/'.length)], ref).toBeTruthy();
    }
    expect(operation('get', '/api/suites').responses['200']!.content!['application/json']).toEqual({
      schema: { type: 'array', items: { $ref: '#/components/schemas/SuiteListRow' } },
    });
    expect(
      operation('put', '/api/configurations/{id}').requestBody!.content['application/json'],
    ).toEqual({
      schema: { $ref: '#/components/schemas/ConfigurationInput' },
    });
  });

  it('documents the Phase 2 to 4 contracts by name, the streams as text/event-stream', () => {
    const json = (method: string, path: string, status = '200') =>
      operation(method, path).responses[status]!.content!['application/json']!.schema;
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    expect(json('get', '/api/experiments')).toEqual({
      type: 'array',
      items: ref('ExperimentListRow'),
    });
    expect(json('get', '/api/experiments/{id}')).toEqual(ref('ExperimentDetail'));
    expect(json('get', '/api/experiments/new-options')).toEqual(ref('NewExperimentOptions'));
    expect(json('get', '/api/experiments/estimate')).toEqual(ref('ExperimentEstimateView'));
    expect(json('post', '/api/experiments', '201')).toEqual(ref('LaunchExperimentResult'));
    expect(json('post', '/api/experiments/{id}/duplicate')).toEqual(ref('NewExperimentDraft'));
    expect(json('get', '/api/experiments/{id}/comparison')).toEqual(ref('ComparisonView'));
    expect(json('get', '/api/experiments/{id}/runs')).toEqual(ref('RunListResult'));
    expect(json('get', '/api/runs/{id}')).toEqual(ref('RunDetail'));
    expect(json('get', '/api/runs/{id}/events')).toEqual(ref('RunEventsPage'));
    expect(json('get', '/api/runs/{id}/attempts/{n}/stderr')).toEqual(ref('AttemptStderr'));
    expect(json('post', '/api/runs/{id}/retry')).toEqual(ref('RunActionResult'));
    expect(json('post', '/api/experiments/{id}/runs/retry')).toEqual(ref('BulkRunActionResult'));
    expect(json('post', '/api/runs/{id}/rescore')).toEqual(ref('RescoreRunResult'));
    expect(json('post', '/api/experiments/{id}/runs/rescore')).toEqual(ref('BulkRescoreResult'));
    expect(json('get', '/api/providers')).toEqual({ type: 'array', items: ref('ProviderInfo') });
    expect(json('post', '/api/providers/nous/login')).toEqual(ref('NousLogin'));
    for (const [path, name] of [
      ['/api/experiments/{id}/events', 'ExperimentEvent'],
      ['/api/system/events', 'SystemEvent'],
    ] as const) {
      expect(operation('get', path).responses['200']!.content).toEqual({
        'text/event-stream': { schema: ref(name) },
      });
    }
    const body = (method: string, path: string) =>
      operation(method, path).requestBody!.content['application/json']!.schema;
    expect(body('post', '/api/experiments')).toEqual(ref('LaunchExperiment'));
    expect(body('post', '/api/experiments/{id}/resume')).toEqual(ref('ResumeExperiment'));
    expect(body('post', '/api/experiments/{id}/runs/retry')).toEqual(ref('BulkRunAction'));
    expect(body('post', '/api/experiments/{id}/runs/rescore')).toEqual(ref('BulkRunAction'));
    const query = (path: string) =>
      (operation('get', path).parameters ?? [])
        .filter((p) => p.in === 'query')
        .map((p) => p.name)
        .sort();
    expect(query('/api/experiments/estimate')).toEqual([
      'budget',
      'concurrency',
      'repetitions',
      'suite',
      'tasks',
      'versions',
    ]);
    expect(query('/api/runs/{id}/events')).toEqual(['after']);
    expect(query('/api/experiments/{id}/comparison')).toEqual(['candidate', 'filter', 'key']);
  });

  it('documents the Phase 5b contracts by name, and the refusals the pages read', () => {
    const json = (method: string, path: string, status = '200') =>
      operation(method, path).responses[status]!.content!['application/json']!.schema;
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    const body = (method: string, path: string) =>
      operation(method, path).requestBody!.content['application/json']!.schema;
    const draft = '/api/suites/{suite}/draft';
    expect(json('get', '/api/suites/drafts')).toEqual({
      type: 'array',
      items: ref('DraftSummary'),
    });
    expect(json('post', '/api/suites/drafts', '201')).toEqual(ref('SuiteDraftView'));
    expect(body('post', '/api/suites/drafts')).toEqual(ref('CreateSuiteDraftRequest'));
    expect(json('post', draft, '201')).toEqual(ref('SuiteDraftView'));
    expect(json('get', `${draft}/review`)).toEqual(ref('DraftReview'));
    expect(json('put', `${draft}/tasks/{key}`)).toEqual(ref('DraftTaskDetail'));
    expect(body('put', `${draft}/tasks/{key}`)).toEqual(ref('UpdateDraftTaskRequest'));
    expect(json('get', `${draft}/tasks/{key}/readiness`)).toEqual(ref('TaskReadiness'));
    expect(json('post', `${draft}/tasks/{key}/try`)).toEqual(ref('TryCheckResult'));
    expect(json('post', `${draft}/tasks/{key}/self-check`)).toEqual(ref('DraftSelfCheckView'));
    expect(json('post', `${draft}/save`)).toEqual(ref('DraftSaveResult'));
    expect(json('post', `${draft}/save`, '409')).toEqual(ref('DraftConflictBody'));
    expect(json('post', `${draft}/save`, '422')).toEqual(ref('DraftSaveFailureBody'));
    expect(json('post', `${draft}/rebase`, '409')).toEqual(ref('DraftConflictBody'));
    expect(json('post', `${draft}/import`, '422')).toEqual(ref('TaskImportRefusalBody'));
    expect(json('post', '/api/suites/import/validate')).toEqual(ref('SuiteZipValidation'));
    expect(body('post', '/api/suites/import')).toEqual(ref('SuiteZipImportRequest'));
    expect(json('get', '/api/suites/reload/progress')).toEqual(ref('SuiteReloadProgress'));
    expect(json('delete', '/api/resources/skills/{id}', '409')).toEqual(ref('ResourceInUseBody'));
    expect(
      operation('get', '/api/suites/{suite}/versions/{n}/zip').responses['200']!.content,
    ).toEqual({ 'application/zip': { schema: { type: 'string', format: 'binary' } } });
  });

  it('converts the contracts field by field', () => {
    const schemas = document.components!.schemas! as Record<string, Record<string, unknown>>;
    const input = schemas['McpServerInput']!;
    expect(input['type']).toBe('object');
    expect(Object.keys(input['properties'] as object)).toEqual(
      expect.arrayContaining(['name', 'transport', 'envNames', 'headers', 'timeoutS']),
    );
    expect(schemas['McpTestView']!['oneOf']).toHaveLength(4);
    const launch = schemas['LaunchExperiment']!;
    expect(Object.keys(launch['properties'] as object)).toEqual(
      expect.arrayContaining(['name', 'taskKeys', 'candidateVersionIds', 'expectedConfigHashes']),
    );
    expect(JSON.stringify(schemas['ExperimentDetail'])).toContain('perConfiguration');
    // The four SSE event types of one experiment.
    expect(schemas['ExperimentEvent']!['oneOf']).toHaveLength(4);
  });
});

describe('the Swagger UI request interceptor', () => {
  /** As Swagger UI gets it: the function's source, evaluated in a fresh global scope. */
  const shipped = runInNewContext(
    `(${swaggerRequestInterceptor.toString()})`,
  ) as typeof swaggerRequestInterceptor;

  const headersOf = (req: { headers?: Record<string, string> }) =>
    Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

  it('adds X-Requested-With and a JSON body to a bare POST, so the guard lets it through', () => {
    const req = shipped({ method: 'POST', headers: {} });
    expect(req.body).toBe('{}');
    expect(refusalOf('POST', headersOf(req))).toBeNull();
  });

  it('keeps a JSON or multipart body as Swagger UI built it', () => {
    const json = shipped({
      method: 'put',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(json.body).toBe('{"a":1}');
    expect(refusalOf('PUT', headersOf(json))).toBeNull();
    const form = { marker: true };
    const multipart = shipped({ method: 'POST', headers: {}, body: form });
    expect(multipart.body).toBe(form);
    expect(headersOf(multipart)['x-requested-with']).toBe('swagger-ui');
  });

  it('leaves reads alone', () => {
    expect(shipped({ method: 'GET', headers: {} })).toEqual({ method: 'GET', headers: {} });
  });
});
