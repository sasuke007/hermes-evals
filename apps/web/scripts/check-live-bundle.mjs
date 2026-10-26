#!/usr/bin/env node
/**
 * Proves that a live build leaves the fixtures out (Phase 5 question 21): builds the app
 * with VITE_API_MODE=live into a temporary folder and looks there for strings that only the
 * fixture world holds (src/fixtures and the draft world, which src/api/fixture-world.ts
 * gathers behind a dynamic import). Each string must still be in its source file, so the
 * check cannot pass by a string having been reworded, and in none of the built files.
 * `--control` also builds in fixtures mode and expects every string there.
 *
 *   pnpm --filter @hermes-evals/web check:live-bundle [--control]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Strings only fixture modules hold, each with the file that holds it. */
const MARKERS = [
  { text: 'Hermes looks up model prices', source: 'src/fixtures/inspector.ts' },
  { text: 'K7QD-P2MX', source: 'src/fixtures/system.ts' },
  {
    text: 'Reconciling vendor statements against the ledger.',
    source: 'src/fixtures/suites-import.ts',
  },
  { text: '/tmp/selfcheck-3/expected', source: 'src/api/drafts-fixture-score.ts' },
];

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Builds in `mode` into a fresh temporary folder; returns the folder. */
function build(mode) {
  const outDir = mkdtempSync(join(tmpdir(), `hermes-evals-web-${mode}-`));
  execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: root,
    env: { ...process.env, VITE_API_MODE: mode },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return outDir;
}

/** For each marker, the built files that contain it. */
function findMarkers(outDir) {
  const files = filesUnder(outDir).map((path) => ({
    name: relative(outDir, path),
    text: readFileSync(path, 'latin1'),
  }));
  return MARKERS.map((marker) => ({
    marker,
    files: files.filter((f) => f.text.includes(marker.text)).map((f) => f.name),
  }));
}

let failed = false;
for (const { text, source } of MARKERS) {
  if (!readFileSync(join(root, source), 'utf8').includes(text)) {
    console.error(`marker "${text}" is no longer in ${source}: pick another fixture-only string`);
    failed = true;
  }
}
if (failed) process.exit(2);

const live = build('live');
try {
  const chunks = filesUnder(live).filter((path) => path.includes('fixture-world'));
  if (chunks.length > 0) {
    console.error(`live build: a fixture-world chunk was emitted: ${chunks.join(', ')}`);
    failed = true;
  }
  const files = filesUnder(live).length;
  for (const { marker, files: found } of findMarkers(live)) {
    if (found.length > 0) {
      console.error(`live build: "${marker.text}" found in ${found.join(', ')}`);
      failed = true;
    } else {
      console.log(`live build: "${marker.text}" in none of ${files} files`);
    }
  }
} finally {
  rmSync(live, { recursive: true, force: true });
}

if (process.argv.includes('--control')) {
  const fixtures = build('fixtures');
  try {
    for (const { marker, files: found } of findMarkers(fixtures)) {
      if (found.length === 0) {
        console.error(`fixtures build: "${marker.text}" not found; the check proves nothing`);
        failed = true;
      } else {
        console.log(`fixtures build: "${marker.text}" in ${found.join(', ')}`);
      }
    }
  } finally {
    rmSync(fixtures, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
