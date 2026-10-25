/**
 * The pure pieces of the inspector that the database specs reach only in
 * their common cases: the launch command and config.yaml as shown (secrets
 * masked whatever the stored record holds), expected and observed values,
 * the stderr tail, and the final response's ranges for broken answers.
 */
import { describe, expect, it } from 'vitest';
import { FinalResponseViewSchema, LaunchRecordViewSchema } from '@hermes-evals/shared';
import { HERMES_REVISION, sha } from '../../../test/support/seed.js';
import { finalResponseView } from './final-response.js';
import {
  commandLine,
  launchRecordView,
  RUN_TOKEN_PLACEHOLDER,
  showSecretRefs,
} from './launch-record.js';
import { STDERR_TAIL_LINES, stderrLines, valueSummary } from './outcome.js';
import { launchRecord } from './run-fixtures-spec.js';
import type { WorkerRecord } from './rows.js';

describe('the launch command', () => {
  it('masks the run token in either form and quotes what a shell would split', () => {
    expect(
      commandLine([
        '/opt/hermes/.venv/bin/hermes',
        'chat',
        '--api-key=s3cret',
        '-m',
        "it's mine",
        'a b',
      ]),
    ).toBe(`hermes chat --api-key=${RUN_TOKEN_PLACEHOLDER} -m 'it'\\''s mine' 'a b'`);
    expect(commandLine(['hermes', '--api-key', 's3cret', '--provider', 'custom'])).toBe(
      `hermes --api-key ${RUN_TOKEN_PLACEHOLDER} \\\n  --provider custom`,
    );
  });

  it('shows config.yaml with secret references by name and any api_key masked', () => {
    expect(showSecretRefs('env:\n  TOKEN: ${VENDOR_TOKEN}\nmodel:\n  api_key: sk-live-123\n')).toBe(
      `env:\n  TOKEN: <from env VENDOR_TOKEN>\nmodel:\n  api_key: "${RUN_TOKEN_PLACEHOLDER}"\n`,
    );
  });

  it("draws the container from the runner's stored block, else from the trial defaults", () => {
    const attempt = { startedAt: new Date('2026-10-24T15:00:00.000Z'), exitCode: 0 };
    const worker: Pick<WorkerRecord, 'hostname' | 'sandbox'> = {
      hostname: 'worker-1',
      sandbox: {
        state: 'isolated',
        checks: [],
        checked_at: '2026-10-24T09:00:00.000Z',
        image: 'trial:a',
        revision: HERMES_REVISION,
        image_digest: `sha256:${'7a'.repeat(32)}`,
      },
    };
    const base = launchRecord(sha('fixture'));
    const stored = LaunchRecordViewSchema.parse(
      launchRecordView({
        record: {
          ...base,
          container: {
            image: 'trial:b',
            network: 'hermes-evals-trial-3',
            user: '10000:10000',
            read_only_root: true,
            limits: { memory_mib: 2048, cpus: 2, pids: 512, tmp_mib: 256 },
            mounts: [{ target: '/opt/data' }, { target: '/workspace' }, { target: '/cache' }],
            disk_cap: { bytes: 1024 ** 3, files: 10_000 },
          },
        },
        attempt,
        worker,
        fallbackImage: 'trial:fallback',
      }),
    );
    expect(stored.container).toMatchObject({
      image: 'trial:b',
      // The self-test's digest is of trial:a.
      digest: 'not reported',
      network: 'hermes-evals-trial-3',
      limits: { memory: '2 GB', cpus: 2, processes: 512, tmp: '256 MB' },
      mounts: [
        { name: 'home', target: '/opt/data' },
        { name: 'workspace', target: '/workspace' },
        { name: '/cache', target: '/cache' },
      ],
      diskCap: { bytes: 1024 ** 3, files: 10_000 },
    });

    const { container: _dropped, ...withoutContainer } = base as typeof base & {
      container?: unknown;
    };
    const fallback = LaunchRecordViewSchema.parse(
      launchRecordView({ record: withoutContainer, attempt, worker, fallbackImage: 'trial:x' }),
    );
    expect(fallback.container).toMatchObject({
      image: 'trial:a',
      digest: `sha256:${'7a'.repeat(32)}`,
      network: 'trial slot network (internal)',
      imageFilesystem: 'read-only',
      limits: { memory: '1.5 GB', cpus: 1, processes: 1024, tmp: '512 MB' },
      diskCap: { bytes: 2 * 1024 ** 3, files: 50_000 },
    });
  });

  it('shows no launch record for one that does not parse', () => {
    const attempt = { startedAt: new Date(), exitCode: null };
    for (const record of [null, { argv: 'hermes' }, 42]) {
      expect(launchRecordView({ record, attempt, worker: null, fallbackImage: 'img' })).toBeNull();
    }
  });
});

describe('expected and observed values', () => {
  it('summarises a value in a few characters and keeps the whole in the detail', () => {
    expect(valueSummary(null)).toBeNull();
    expect(valueSummary(undefined)).toBeNull();
    expect(valueSummary(1042.5)).toEqual({ summary: '1042.5', detail: null });
    expect(valueSummary('1042')).toEqual({ summary: '"1042"', detail: null });
    expect(valueSummary([])).toEqual({ summary: '0 items', detail: '[]' });
    expect(valueSummary({ a: 1 })).toEqual({ summary: '{"a": 1}', detail: null });
    const long = { vendor: 'Brightline Freight', outstanding: 6215, currency: 'EUR' };
    expect(valueSummary(long)).toEqual({
      summary: '3 keys',
      detail: '{"vendor": "Brightline Freight", "outstanding": 6215, "currency": "EUR"}',
    });
    const text = 'x'.repeat(60);
    expect(valueSummary(text)!.summary).toHaveLength(48);
    expect(valueSummary(text)!.detail).toBe(JSON.stringify(text));
    const many = Array.from({ length: 60 }, (_, i) => i);
    expect(valueSummary(many)!.detail!.split('\n')).toHaveLength(51);
  });
});

describe('the stderr tail', () => {
  it('drops the trailing newline and keeps the last 40 lines', () => {
    expect(stderrLines('a\nb\n')).toEqual(['a', 'b']);
    expect(stderrLines(null)).toEqual([]);
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    expect(stderrLines(lines.join('\n'))).toEqual(lines.slice(-STDERR_TAIL_LINES));
  });
});

describe('the final response of a broken answer', () => {
  it('highlights the block that did not parse and says where', () => {
    const text = 'Answer:\n```json\n{"total": 10,}\n```';
    const view = FinalResponseViewSchema.parse(finalResponseView(text, null, { total: 10 }));
    expect(view).toMatchObject({ extraction: 'invalid', parsed: null });
    expect(text.slice(view.extracted!.start, view.extracted!.end)).toBe('{"total": 10,}');
    expect(text.slice(view.fence!.start, view.fence!.end)).toBe('```json\n{"total": 10,}\n```');
    expect(view.parseError!.message).toMatch(/JSON/);
  });

  it('runs an unclosed block to the end of the text', () => {
    const text = 'Answer:\n```json\n{"total": 10}';
    const view = FinalResponseViewSchema.parse(finalResponseView(text, null, null));
    expect(view).toMatchObject({ extraction: 'invalid', reference: null });
    expect(view.fence).toEqual({ start: 8, end: text.length });
  });
});
