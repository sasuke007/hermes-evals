/**
 * The first `docker compose up --build` from a clean clone (Phase 7) runs
 * every image's `pnpm install` at once, beside the 1.1 GB pull of the Hermes
 * image. On a link of about 3 MB/s, the clean install on a fresh Colima VM
 * failed there: three installs aborted on pnpm's 60 s request timeout
 * ("TimeoutError: The operation was aborted due to timeout", api, worker and
 * web at once). Every install in every Dockerfile under docker/ must run with
 * fewer requests at a time, a long timeout and more retries, which pnpm 11
 * reads from `pnpm_config_*` variables. A new Dockerfile cannot be left out:
 * the files are listed, not named.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOCKER_DIR = fileURLToPath(new URL('../../../docker/', import.meta.url));

/** The settings each install needs, as pnpm reads them from the environment. */
const NETWORK_SETTINGS = {
  pnpm_config_network_concurrency: '4',
  pnpm_config_fetch_timeout: '600000',
  pnpm_config_fetch_retries: '5',
};

interface Install {
  file: string;
  stage: string;
  env: Record<string, string>;
}

/** Instructions with their continuation lines joined, comments dropped. */
function instructions(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!current && (line === '' || line.startsWith('#'))) continue;
    if (line.endsWith('\\')) {
      current += `${line.slice(0, -1).trim()} `;
      continue;
    }
    out.push(`${current}${line}`.trim());
    current = '';
  }
  if (current) out.push(current.trim());
  return out;
}

/** `K=V K2=V2` pairs of an ENV instruction (no quoting is used in these files). */
function envPairs(args: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const word of args.split(/\s+/)) {
    const at = word.indexOf('=');
    if (at > 0) pairs[word.slice(0, at)] = word.slice(at + 1);
  }
  return pairs;
}

/**
 * Every RUN that calls `pnpm install`, with the environment its stage has:
 * a stage built FROM an earlier stage inherits that stage's ENV.
 */
function pnpmInstalls(file: string, text: string): Install[] {
  const stages = new Map<string, Record<string, string>>();
  const installs: Install[] = [];
  let stage = '';
  let env: Record<string, string> = {};
  for (const instruction of instructions(text)) {
    const [keyword = '', ...rest] = instruction.split(/\s+/);
    const args = rest.join(' ');
    switch (keyword.toUpperCase()) {
      case 'FROM': {
        const [image = '', as, name] = rest;
        env = { ...stages.get(image) };
        stage = as?.toUpperCase() === 'AS' && name ? name : image;
        stages.set(stage, env);
        break;
      }
      case 'ENV':
        Object.assign(env, envPairs(args));
        break;
      case 'RUN':
        if (/\bpnpm install\b/.test(args)) installs.push({ file, stage, env: { ...env } });
        break;
    }
  }
  return installs;
}

async function dockerfiles(): Promise<{ file: string; text: string }[]> {
  const names = (await readdir(DOCKER_DIR)).filter((name) => name.endsWith('Dockerfile')).sort();
  return Promise.all(
    names.map(async (file) => ({ file, text: await readFile(join(DOCKER_DIR, file), 'utf8') })),
  );
}

describe('Dockerfiles: pnpm installs survive a slow link', () => {
  it('finds the install of every image Compose builds from the workspace', async () => {
    const files = await dockerfiles();
    const withInstall = files.filter(({ file, text }) => pnpmInstalls(file, text).length > 0);
    expect(withInstall.map(({ file }) => file)).toEqual([
      'api.Dockerfile',
      'node-service.Dockerfile',
      'web.Dockerfile',
      'worker.Dockerfile',
    ]);
  });

  it('runs every pnpm install with fewer requests at once, a 10 minute timeout and 5 retries', async () => {
    const installs = (await dockerfiles()).flatMap(({ file, text }) => pnpmInstalls(file, text));
    expect(installs.length).toBeGreaterThanOrEqual(4);
    for (const install of installs) {
      const settings = Object.fromEntries(
        Object.keys(NETWORK_SETTINGS).map((key) => [key, install.env[key]]),
      );
      expect([install.file, install.stage, settings]).toEqual([
        install.file,
        install.stage,
        NETWORK_SETTINGS,
      ]);
    }
  });

  it('reads a stage environment through continuation lines and inherited stages', () => {
    const text = [
      'FROM node:22 AS base',
      '# a comment \\',
      'ENV A=1 \\',
      '    pnpm_config_fetch_timeout=600000',
      'FROM base AS deps',
      'RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile',
      'FROM node:22 AS other',
      'RUN pnpm install',
    ].join('\n');
    expect(pnpmInstalls('x', text)).toEqual([
      { file: 'x', stage: 'deps', env: { A: '1', pnpm_config_fetch_timeout: '600000' } },
      { file: 'x', stage: 'other', env: {} },
    ]);
  });
});
