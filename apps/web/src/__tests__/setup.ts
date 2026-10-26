/**
 * Vitest setup: load the fixture world once per test file, before any test runs.
 *
 * The data layer reaches src/fixtures only through source.ts's dynamic import (Phase 5
 * #21). Loaded here, every fixture call after it answers within the same few microtasks
 * as before, so a test's `flushPromises()` still sees the page settled.
 */
import { fixtureWorld } from '@/api/source';

if (import.meta.env.VITE_API_MODE === 'fixtures') await fixtureWorld();
