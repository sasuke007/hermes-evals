import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly detail: string,
  ) {
    super(`${path} → ${status} · ${detail}`);
  }
}

/** Minimal typed fetch wrapper. Every response is validated against its shared zod schema. */
export async function apiGet<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, `GET /api${path}`, (await res.text()).slice(0, 300));
  return schema.parse(await res.json());
}
