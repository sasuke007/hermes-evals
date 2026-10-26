/**
 * The fixture world: every module fixtures mode serves, by name. Nothing imports this file
 * statically; source.ts's fixtureWorld() loads it with a dynamic import that a live build
 * leaves out, so src/fixtures and the draft world (./drafts-fixture*.ts) never reach the
 * live bundle (Phase 5 #21). Tests import the fixture modules directly; this file only
 * gives the data layer one door to them.
 */
export * as comparison from '@/fixtures/comparison';
export * as configurations from '@/fixtures/configurations';
export * as experiments from '@/fixtures/experiments';
export * as home from '@/fixtures/home';
export * as inspector from '@/fixtures/inspector';
export * as inspectorLogs from '@/fixtures/inspector-logs';
export * as resources from '@/fixtures/resources';
export * as runs from '@/fixtures/runs';
export * as suites from '@/fixtures/suites';
export * as suitesAuthoring from '@/fixtures/suites-authoring';
export * as suitesImport from '@/fixtures/suites-import';
export * as system from '@/fixtures/system';
export * as draftOps from './drafts-fixture-ops';
export * as draftSave from './drafts-fixture-save';
