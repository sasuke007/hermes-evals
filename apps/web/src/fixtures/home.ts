/**
 * Home fixtures (Phase 6 P1 and P2), all behind the `memory-files` scenario: the task
 * per_vendor seeds the agent's memory with home/memories/MEMORY.md and USER.md, keeps an
 * expected_home folder for its home check (`saved_preference`, a file_check with root home on
 * memories/USER.md), and every finished run of it lists the memory files collected from the
 * home: MEMORY.md as the seed unchanged, USER.md modified on the runs whose answer passed
 * (the agent saved the preference the prompt states) and unchanged on the others. Its launch
 * records list both seeds. Without the scenario no task has home files, as in invoices-v1.
 */
import { MEMORY_ENTRY_DELIMITER } from '@hermes-evals/shared';
import type { ArtifactView, LaunchRecordView } from '@/api/types/runs';
import type { TaskDetail, TaskHomeFile, VerificationEntryView } from '@/api/types/suites';
import type { RunSeed } from './experiments';
import { sha, ulid } from './suites';

type Active = (name: string) => boolean;

export const MEMORY_FILES_SCENARIO = 'memory-files';
/** The task the scenario gives home files. */
export const HOME_TASK = 'per_vendor';

const entries = (...lines: string[]): string => `${lines.join(MEMORY_ENTRY_DELIMITER)}\n`;

const MEMORY_SEED = entries(
  'Vendor names in invoices.csv can carry trailing spaces; "Kestrel Office Supply " and "Kestrel Office Supply" are one vendor.',
  'Outstanding means every invoice that is not paid, disputed ones included.',
);
const USER_SEED = entries('Reports amounts in EUR with two decimals.');
const PREFERENCE = 'Wants vendor totals sorted by amount, largest first.';
const USER_SAVED = entries('Reports amounts in EUR with two decimals.', PREFERENCE);

const bytes = (text: string): number => new TextEncoder().encode(text).length;

interface HomeFileSeed {
  /** Relative to the home: memories/USER.md. */
  homePath: string;
  text: string;
  sha256: string;
}

const SEEDS: HomeFileSeed[] = [
  { homePath: 'memories/MEMORY.md', text: MEMORY_SEED, sha256: sha('home-seed-MEMORY.md', '5e1b') },
  { homePath: 'memories/USER.md', text: USER_SEED, sha256: sha('home-seed-USER.md', 'a08c') },
];
const USER_EXPECTED: HomeFileSeed = {
  homePath: 'memories/USER.md',
  text: USER_SAVED,
  sha256: sha('expected-home-USER.md', '7c3f'),
};

const active = (is: Active, taskKey: string): boolean =>
  is(MEMORY_FILES_SCENARIO) && taskKey === HOME_TASK;

/** The home check the scenario adds to per_vendor's verification. */
export const SAVED_PREFERENCE_CHECK: VerificationEntryView = {
  key: 'saved_preference',
  type: 'file_check',
  primary: false,
  params: {
    root: 'home',
    path: 'memories/USER.md',
    must_exist: true,
    contains: ['largest first'],
  },
  yaml: `- key: saved_preference
  type: file_check
  params:
    root: home
    path: memories/USER.md
    must_exist: true
    contains: [largest first]`,
  sentence: 'file_check: memories/USER.md in the home exists; contains "largest first"',
};

function homeFile(kind: TaskHomeFile['kind'], folder: string, seed: HomeFileSeed): TaskHomeFile {
  return {
    kind,
    path: `${folder}/${seed.homePath}`,
    homePath: seed.homePath,
    sizeBytes: bytes(seed.text),
    sha256: seed.sha256,
    text: seed.text,
  };
}

/** Task detail with its home files: none, or per_vendor's under `memory-files`. */
export function withHomeFiles(is: Active, detail: Omit<TaskDetail, 'homeFiles'>): TaskDetail {
  if (!active(is, detail.key)) return { ...detail, homeFiles: [] };
  return {
    ...detail,
    verification: [...detail.verification, SAVED_PREFERENCE_CHECK],
    selfCheck: {
      ...detail.selfCheck,
      results: [
        ...detail.selfCheck.results,
        {
          key: SAVED_PREFERENCE_CHECK.key,
          type: 'file_check',
          status: 'passed',
          score: 1,
          note: 'passes on the expected home; fails on the home seeds alone, as it should',
        },
      ],
    },
    homeFiles: [
      ...SEEDS.map((s) => homeFile('home_seed', 'home', s)),
      homeFile('expected_home', 'expected_home', USER_EXPECTED),
    ],
  };
}

/** The launch record's home seeds of a run. */
export function homeSeedsFor(is: Active, run: RunSeed): LaunchRecordView['homeSeeds'] {
  return active(is, run.taskKey) ? SEEDS.map((s) => ({ path: s.homePath, sha256: s.sha256 })) : [];
}

/** The memory files collected from a finished run's home. */
export function homeArtifactsFor(is: Active, run: RunSeed): ArtifactView[] {
  if (!active(is, run.taskKey)) return [];
  const saved = run.primaryStatus === 'passed';
  return SEEDS.map((s) => {
    const changed = saved && s.homePath === 'memories/USER.md';
    return {
      id: ulid('art', `${run.id}:home/${s.homePath}`),
      root: 'home',
      path: `home/${s.homePath}`,
      origin: changed ? 'home_seed_modified' : 'home_seed_unchanged',
      sizeBytes: bytes(changed ? USER_SAVED : s.text),
      sha256: changed ? sha(`${run.id}:home/${s.homePath}`) : s.sha256,
      skippedReason: null,
      preview: null,
    };
  });
}

/** The text of a home artifact, for its preview (GET /runs/:id/artifacts/:id/content). */
export function homeArtifactText(artifact: ArtifactView): string | null {
  if (artifact.root !== 'home') return null;
  if (artifact.origin === 'home_seed_modified') return USER_SAVED;
  return SEEDS.find((s) => `home/${s.homePath}` === artifact.path)?.text ?? null;
}
