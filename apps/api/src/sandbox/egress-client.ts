/**
 * Talks to egress over its admin socket: register an attempt (token, network
 * policy, model access) before its trial starts, and remove it when the trial
 * ends, collecting the attempt's model usage and connection log. The worker
 * also asks it which environment variable names it holds (secret presence,
 * plan 5.3); values never cross the socket.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import { ENV_NAME_PATTERN } from '@hermes-evals/shared';

export interface EgressRegistration {
  token: string;
  mode: 'allowlist' | 'public';
  allowHosts?: string[];
  allowPorts?: number[];
  provider: string | null;
  models?: string[];
  maxTokens?: number;
  expiresAt: number;
}

export interface EgressUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface EgressLogEntry {
  at: string;
  kind: 'connect' | 'http' | 'model';
  host?: string;
  ip?: string;
  port?: number;
  model?: string;
  decision: 'allowed' | 'denied';
  reason?: string;
  status?: number;
  bytesUp?: number;
  bytesDown?: number;
  ms?: number;
}

const EnvNamesResponseSchema = z.object({ names: z.array(z.string().regex(ENV_NAME_PATTERN)) });

/** A fresh per-attempt secret: 256 bits, URL-safe. */
export const newAttemptToken = (): string => randomBytes(32).toString('base64url');

export class EgressClient {
  constructor(private readonly socketPath: string) {}

  private call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request({
        socketPath: this.socketPath,
        method,
        path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`egress ${method} ${path} timed out`)));
      req.on('response', (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          // A throw inside this listener would be an uncaught exception and end the worker.
          try {
            resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
          } catch {
            reject(
              new Error(`egress ${method} ${path} answered ${res.statusCode} with invalid JSON`),
            );
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  async register(attemptId: string, registration: EgressRegistration): Promise<void> {
    const res = await this.call('PUT', `/attempts/${attemptId}`, registration);
    if (res.status !== 204)
      throw new Error(`egress refused registration: ${JSON.stringify(res.json)}`);
  }

  /** Removes the attempt; its token stops working at once. Returns what it used and did. */
  async remove(attemptId: string): Promise<{ usage: EgressUsage; log: EgressLogEntry[] } | null> {
    const res = await this.call('DELETE', `/attempts/${attemptId}`);
    return res.status === 200 ? (res.json as { usage: EgressUsage; log: EgressLogEntry[] }) : null;
  }

  /**
   * Sorted names of the variables set in egress's environment: where the
   * values of http MCP headers live. Throws when egress cannot be reached or
   * answers anything else; the caller decides what an unknown list means.
   * The timeout is short because the worker asks on every 10 s heartbeat.
   */
  async envNames(timeoutMs = 3_000): Promise<string[]> {
    const res = await this.call('GET', '/env-names', undefined, timeoutMs);
    if (res.status !== 200) throw new Error(`egress GET /env-names answered ${res.status}`);
    return EnvNamesResponseSchema.parse(res.json).names;
  }

  async health(): Promise<boolean> {
    try {
      return (await this.call('GET', '/health')).status === 200;
    } catch {
      return false;
    }
  }
}
