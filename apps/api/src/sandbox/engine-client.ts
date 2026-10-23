/**
 * A minimal Docker Engine API client over a unix socket. The worker points it
 * at docker-guard, never at the real Docker socket, so every call here is one
 * the guard allows: create, start, stop, kill, wait, logs, inspect, remove and
 * list of trial containers.
 */
import http, { type IncomingMessage } from 'node:http';

const API_VERSION = 'v1.45';

export class EngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ContainerState {
  Status: string;
  Running: boolean;
  ExitCode: number;
  OOMKilled: boolean;
  StartedAt: string;
  FinishedAt: string;
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Labels: Record<string, string>;
  State: string;
  HostConfig?: { NetworkMode?: string };
}

export class EngineClient {
  constructor(private readonly socketPath: string) {}

  private raw(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request({
        socketPath: this.socketPath,
        method,
        path: `/${API_VERSION}${path}`,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`engine ${method} ${path} timed out`)));
      req.on('response', resolve);
      req.on('error', reject);
      req.end(payload);
    });
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const res = await this.raw(method, path, body, timeoutMs);
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const status = res.statusCode ?? 0;
    if (status >= 400) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; details?: string[] };
        message = [parsed.message, ...(parsed.details ?? [])].filter(Boolean).join('; ');
      } catch {
        // keep the raw text
      }
      throw new EngineError(status, `${method} ${path}: ${status} ${message}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  info(): Promise<{ ID: string; ServerVersion: string; Name: string }> {
    return this.json('GET', '/info');
  }

  version(): Promise<{ Version: string; ApiVersion: string }> {
    return this.json('GET', '/version');
  }

  async createContainer(name: string, body: unknown): Promise<string> {
    const created = await this.json<{ Id: string }>(
      'POST',
      `/containers/create?name=${encodeURIComponent(name)}`,
      body,
    );
    return created.Id;
  }

  async start(id: string): Promise<void> {
    await this.json('POST', `/containers/${id}/start`);
  }

  /** SIGTERM, then SIGKILL after `seconds`. Tolerates a container that already stopped. */
  async stop(id: string, seconds: number): Promise<void> {
    try {
      await this.json(
        'POST',
        `/containers/${id}/stop?t=${seconds}`,
        undefined,
        (seconds + 30) * 1000,
      );
    } catch (err) {
      if (!(err instanceof EngineError) || (err.status !== 304 && err.status !== 404)) throw err;
    }
  }

  async kill(id: string): Promise<void> {
    try {
      await this.json('POST', `/containers/${id}/kill`);
    } catch (err) {
      if (!(err instanceof EngineError) || (err.status !== 409 && err.status !== 404)) throw err;
    }
  }

  /**
   * Waits for the container's next exit. `registered` resolves when the Engine has
   * answered with headers, which it does once the wait is in place: await it before
   * start, so an exit straight after start cannot be missed.
   */
  waitForExit(id: string): {
    registered: Promise<void>;
    exited: Promise<{ StatusCode: number }>;
  } {
    const response = this.raw(
      'POST',
      `/containers/${id}/wait?condition=next-exit`,
      undefined,
      24 * 60 * 60 * 1000,
    );
    const exited = response.then(async (res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of res) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      if ((res.statusCode ?? 0) >= 400) {
        throw new EngineError(res.statusCode ?? 0, `wait ${id}: ${res.statusCode} ${text}`);
      }
      return JSON.parse(text) as { StatusCode: number };
    });
    // The caller awaits `exited` later; keep an early failure from being unhandled meanwhile.
    exited.catch(() => {});
    return { registered: response.then(() => undefined), exited };
  }

  /** Resolves when the container next exits. */
  wait(id: string): Promise<{ StatusCode: number }> {
    return this.waitForExit(id).exited;
  }

  inspect(
    id: string,
  ): Promise<{ Id: string; State: ContainerState; Config: { Labels: Record<string, string> } }> {
    return this.json('GET', `/containers/${id}/json`);
  }

  async remove(id: string): Promise<void> {
    try {
      await this.json('DELETE', `/containers/${id}?force=1&v=1`);
    } catch (err) {
      if (!(err instanceof EngineError) || err.status !== 404) throw err;
    }
  }

  list(labels: string[]): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: labels }));
    return this.json('GET', `/containers/json?all=1&filters=${filters}`);
  }

  /** The container's multiplexed stdout and stderr, from its start, following until it exits. */
  async logs(id: string): Promise<IncomingMessage> {
    const res = await this.raw(
      'GET',
      `/containers/${id}/logs?follow=1&stdout=1&stderr=1`,
      undefined,
      24 * 60 * 60 * 1000,
    );
    if ((res.statusCode ?? 0) >= 400) {
      res.resume();
      throw new EngineError(res.statusCode ?? 0, `logs ${id}: ${res.statusCode}`);
    }
    return res;
  }
}
