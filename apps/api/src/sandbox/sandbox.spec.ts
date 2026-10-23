import { checkCreateBody } from '@hermes-evals/docker-guard/policy';
import { describe, expect, it } from 'vitest';
import { FrameDecoder, LineSplitter } from './streams.js';
import { trialContainerBody, type TrialSpec } from './trial-spec.js';

const frame = (stream: 1 | 2, text: string): Buffer => {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

describe('log stream decoding', () => {
  it('reassembles stdout lines split across frames and chunks, and keeps stderr apart', () => {
    const lines: string[] = [];
    const stderr: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    const decoder = new FrameDecoder(
      (chunk) => splitter.push(chunk),
      (chunk) => stderr.push(chunk.toString()),
    );
    const bytes = Buffer.concat([
      frame(1, '{"type":"system"}\n{"type":"te'),
      frame(2, 'warning: something\n'),
      frame(1, 'xt","text":"héllo"}\n'),
      frame(1, '{"type":"result"}'),
    ]);
    // Feed one byte at a time: frame headers and UTF-8 characters split anywhere.
    for (let i = 0; i < bytes.length; i++) decoder.push(bytes.subarray(i, i + 1));
    splitter.end();
    expect(lines).toEqual([
      '{"type":"system"}',
      '{"type":"text","text":"héllo"}',
      '{"type":"result"}',
    ]);
    expect(stderr.join('')).toBe('warning: something\n');
  });

  it('handles a single line far larger than one frame', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    const decoder = new FrameDecoder(
      (chunk) => splitter.push(chunk),
      () => {},
    );
    const big = 'x'.repeat(200_000);
    for (let i = 0; i < big.length; i += 16_384) decoder.push(frame(1, big.slice(i, i + 16_384)));
    decoder.push(frame(1, '\n'));
    expect(lines).toEqual([big]);
  });
});

describe('trial container contract', () => {
  const spec: TrialSpec = {
    name: 'hermes-evals-run-01K8ZQ7M3V5X9C2B4N6P8R0T1W',
    runId: '01K8ZQ7M3V5X9C2B4N6P8R0T1W',
    attemptId: '01K8ZQ7M3V5X9C2B4N6P8R0T1X',
    image: 'hermes-evals/trial:v0.22.4-4d04303',
    volume: 'hermes-evals-trials',
    network: 'hermes-evals-trial-0',
    cmd: ['chat', '--oneshot'],
    env: { HOME: '/opt/data' },
    deadline: 1_900_000_000,
  };
  const guard = {
    trialImage: 'hermes-evals/trial:v0.22.4-4d04303',
    trialVolume: 'hermes-evals-trials',
    trialNetworks: ['hermes-evals-trial-0', 'hermes-evals-trial-1'],
  };

  it('builds exactly the body docker-guard accepts', () => {
    const result = checkCreateBody(JSON.parse(JSON.stringify(trialContainerBody(spec))), guard);
    expect(result.ok ? 'accepted' : result.reasons).toBe('accepted');
  });

  it('is accepted offline too, and refused on a network the guard does not know', () => {
    expect(
      checkCreateBody(
        JSON.parse(JSON.stringify(trialContainerBody({ ...spec, network: 'none' }))),
        guard,
      ).ok,
    ).toBe(true);
    expect(
      checkCreateBody(
        JSON.parse(
          JSON.stringify(trialContainerBody({ ...spec, network: 'hermes-evals_backend' })),
        ),
        guard,
      ).ok,
    ).toBe(false);
  });
});
