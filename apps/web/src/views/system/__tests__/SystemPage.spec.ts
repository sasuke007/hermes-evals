/**
 * The System page in each state the System, SystemDark and ModelAccessStates boards draw,
 * from fixtures: Model access with every provider and the Used by line, Secrets, the Sandbox
 * (proven, failing), Workers (online, none), and the first load (skeletons, errors, empty).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '@/router';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import SystemPage from '@/views/system/SystemPage.vue';

let wrapper: VueWrapper | null = null;

async function mountPage(scenario: string | null) {
  useScenario(scenario);
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/system');
  await router.isReady();
  wrapper = mount(SystemPage, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  useProvidersStore().dispose();
  useSystemStore().dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const section = (id: string) => wrapper!.get(`section[data-section="${id}"]`);
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
const cells = (row: { findAll: VueWrapper['findAll'] }) =>
  row.findAll('td').map((td) => flat(td.text()));

describe('SystemPage', () => {
  it('draws the header and the four sections in order', async () => {
    const w = await mountPage(null);
    expect(w.get('h1').text()).toBe('System');
    expect(w.text()).toContain(
      'Model access, the run sandbox and the workers. Read live from the running stack. This page never shows or stores a token or a key.',
    );
    expect(w.findAll('h2').map((h) => h.text())).toEqual([
      'Model access',
      'Secrets',
      'Sandbox',
      'Workers',
    ]);
    expect(section('secrets').text()).toContain(
      'names only · values are never shown, typed or stored here',
    );
    expect(section('sandbox').text()).toContain('every run executes in its own container');
    expect(section('workers').text()).toContain('heartbeat every 10 s');
    expect(w.find('input').exists()).toBe(false);
  });

  describe('Model access', () => {
    it('lists every provider with the board columns and the Used by line', async () => {
      await mountPage(null);
      const s = section('model-access');
      expect(s.findAll('th').map((th) => th.text())).toEqual([
        'Provider',
        'Authenticates with',
        'Status',
        'Detail',
        'Action',
      ]);
      const rows = s.findAll('tr[data-provider]');
      expect(rows.map((r) => r.attributes('data-provider'))).toEqual(['nous', 'openrouter']);
      expect(cells(rows[0]!)).toEqual([
        'Nous Portal',
        'Sign-in with Nous Portal',
        'connected',
        'Signed in · scope inference',
        'Disconnect',
      ]);
      const openRouter = cells(rows[1]!);
      expect(openRouter.slice(0, 3)).toEqual(['OpenRouter', 'API key in .env', 'missing']);
      expect(openRouter[3]).toContain(
        'Add OPENROUTER_API_KEY=… to .env at the repository root, then run docker compose up -d egress worker.',
      );
      expect(openRouter[4]).toBe('No input here: keys are never accepted or stored in the UI.');
      expect(flat(s.get('[data-used-by="nous"]').text())).toBe(
        'Used by: baseline, with-skill, with-mcp (all Nous Portal).',
      );
      expect(s.get('[data-used-by="nous"]').findAll('code')).toHaveLength(3);
    });

    it('asks before disconnecting, inside the table', async () => {
      await mountPage(null);
      const s = section('model-access');
      await s.get('tr[data-provider="nous"] button').trigger('click');
      const confirm = s.get('[data-testid="psr-confirm-row"]');
      expect(confirm.get('td').attributes('colspan')).toBe('5');
      expect(flat(confirm.text())).toContain(
        'Disconnect Nous Portal? Running experiments that use it will pause.',
      );
    });

    it.each([
      ['nous-not-connected', 'not connected', ['Connect Nous Portal']],
      ['nous-waiting', 'waiting', ['Open dialog', 'Cancel']],
      ['nous-renewal', 'reconnect', ['Reconnect']],
      ['nous-expired', 'expired', ['Get a new code']],
      ['nous-declined', 'declined', ['Try again']],
      ['nous-subscription', 'subscription', ['Open Nous Portal billing ↗']],
      ['nous-failed', 'error', ['Try again']],
      ['nous-host', 'this machine', []],
      ['nous-host-down', 'not running', []],
      ['nous-unavailable', 'unavailable', ['Show how to connect from a terminal']],
    ])('%s: the Nous row reads %s', async (scenario, chip, actions) => {
      await mountPage(scenario);
      const row = section('model-access').get('tr[data-provider="nous"]');
      expect(row.get('[data-kind="provider"]').text()).toBe(chip);
      expect(row.findAll('[data-testid="psr-actions"] .btn').map((b) => b.text())).toEqual(actions);
    });

    it('nous-host-down: the command to start the host proxy, with Copy', async () => {
      await mountPage('nous-host-down');
      const row = section('model-access').get('tr[data-provider="nous"]');
      expect(row.text()).toContain(
        "This stack uses this machine's Hermes login, but its proxy is not running. Start it in a terminal:",
      );
      expect(row.get('[data-testid="copy-command"] code').text()).toBe(
        'hermes proxy start --provider nous',
      );
    });

    it('names a few configurations per provider, then the rest on request', async () => {
      await mountPage(null);
      const providers = useProvidersStore();
      providers.providers[0]!.usedBy = Array.from({ length: 8 }, (_, i) => `cfg-${i + 1}`);
      providers.providers[1]!.usedBy = ['or-baseline'];
      await flushPromises();
      const s = section('model-access');
      expect(flat(s.get('[data-used-by="nous"]').text())).toBe(
        'Used by: cfg-1, cfg-2, cfg-3, cfg-4, cfg-5 and 3 more (Nous Portal).',
      );
      expect(flat(s.get('[data-used-by="openrouter"]').text())).toBe(
        'Used by: or-baseline (OpenRouter).',
      );
      const toggle = s.get('[data-testid="used-by-toggle"]');
      expect(toggle.text()).toBe('Show every configuration');
      await toggle.trigger('click');
      expect(s.get('[data-used-by="nous"]').findAll('code')).toHaveLength(8);
      expect(toggle.text()).toBe('Show fewer');
      expect(toggle.attributes('aria-expanded')).toBe('true');
    });

    it('reads the providers again every 5 s, so a terminal login shows without a reload', async () => {
      vi.useFakeTimers();
      await mountPage(null);
      const load = vi.spyOn(useProvidersStore(), 'load');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe('Secrets', () => {
    it('lists names, presence and exposure, never a value', async () => {
      await mountPage(null);
      const s = section('secrets');
      expect(s.findAll('th').map((th) => th.text())).toEqual([
        'Secret',
        'Status',
        'Used by',
        'Exposure',
        'Manage',
      ]);
      const rows = s.findAll('tr[data-secret]');
      expect(rows.map((r) => r.attributes('data-secret'))).toEqual([
        'INVOICE_DB_URL',
        'VENDOR_API_TOKEN',
      ]);
      expect(cells(rows[0]!)).toEqual([
        'INVOICE_DB_URL',
        'set',
        'stdio MCP server invoice-db, env',
        'Readable by the agent',
        'Manage in Resources › Secrets',
      ]);
      expect(cells(rows[1]!)).toEqual([
        'VENDOR_API_TOKEN',
        'set',
        'http MCP server vendor-api, header Authorization',
        'Added by egress · never in the run',
        'Manage in Resources › Secrets',
      ]);
      expect(rows[0]!.get('a').attributes('href')).toBe('/resources/secrets');
    });

    it('secret-not-set: the chip says so', async () => {
      await mountPage('secret-not-set');
      const chip = section('secrets').get('tr[data-secret="INVOICE_DB_URL"] [data-kind="secret"]');
      expect(chip.text()).toBe('not set');
      expect(chip.attributes('data-tone')).toBe('ung');
    });

    it('empty: no MCP server references a name yet', async () => {
      await mountPage('empty');
      const empty = section('secrets').get('[data-testid="empty-state"]');
      expect(empty.text()).toContain('No secrets referenced');
      expect(empty.text()).toContain(
        'A name appears here when an MCP server lists it as an environment variable or header. The app then shows whether it is set, never its value.',
      );
      expect(empty.get('a').text()).toBe('Define MCP server');
      expect(empty.get('a').attributes('href')).toBe('/resources/mcp');
    });
  });

  describe('Sandbox', () => {
    it('proven: collapsed to its summary, the revision short', async () => {
      await mountPage(null);
      const s = section('sandbox');
      expect(s.find('[role="alert"]').exists()).toBe(false);
      expect(s.get('[data-testid="sandbox-summary"]').text()).toBe(
        'Isolation proven · 16 of 16 checks · checked 2 min ago at worker start',
      );
      expect(s.text()).toContain('Hermes hermes-agent v0.22.4 @ 4d04303');
      expect(s.findAll('li[data-check]')).toHaveLength(0);
      expect(s.get('button[aria-expanded]').text()).toBe('Show 16 checks');
    });

    it('sandbox-failed: execution disabled, the failing checks open', async () => {
      await mountPage('sandbox-failed');
      const s = section('sandbox');
      expect(s.get('[role="alert"]').text()).toContain(
        'Execution is disabled: 2 of 16 isolation checks failed. No run will start until every check passes.',
      );
      expect(s.get('[role="alert"]').text()).toContain(
        'docker compose exec worker node dist/sandbox-cli.js selftest',
      );
      expect(s.findAll('li[data-passed="false"]').map((li) => li.attributes('data-check'))).toEqual(
        ['gateway-only', 'refuses-private-web'],
      );
      const sandboxChip = section('workers').get('[data-kind="sandbox"]');
      expect(sandboxChip.text()).toBe('not proven');
    });
  });

  describe('Workers', () => {
    it('online: heartbeat, concurrency, trial slots and the sandbox', async () => {
      await mountPage(null);
      const s = section('workers');
      expect(s.findAll('th').map((th) => th.text())).toEqual([
        'Worker',
        'Status',
        'Last heartbeat',
        'Concurrency',
        'Trial slots in use',
        'Sandbox',
      ]);
      const row = cells(s.get('tr[data-worker="worker-1"]'));
      expect(row[0]).toBe('worker-1');
      expect(row[1]).toBe('online');
      expect(row[2]).toMatch(/^\d\d:\d\d:\d\d · \d s ago$/);
      expect(row.slice(3)).toEqual(['3', '2 of 4', 'proven']);
      expect(s.find('[data-testid="no-worker-alert"]').exists()).toBe(false);
    });

    it('shows the effective concurrency when the slots cap it', async () => {
      await mountPage(null);
      const system = useSystemStore();
      system.summary!.workers[0]!.concurrency = 6;
      system.summary!.workers[0]!.effectiveConcurrency = 4;
      await flushPromises();
      const cell = section('workers').findAll('tr[data-worker] td')[3]!;
      expect(flat(cell.text())).toBe('4 of 6');
      expect(cell.attributes('title')).toBe(
        'WORKER_CONCURRENCY is 6; the worker runs 4 at once, one per trial slot',
      );
    });

    it('no-worker: the alert with the last heartbeat, the worker offline', async () => {
      await mountPage('no-worker');
      const s = section('workers');
      const alert = s.get('[data-testid="no-worker-alert"]');
      expect(alert.get('[data-testid="error-banner-title"]').text()).toBe(
        'No worker is connected. 28 queued runs will not start.',
      );
      expect(alert.get('code').text()).toMatch(
        /^last worker heartbeat \d\d:\d\d:\d\d · 2 min ago$/,
      );
      expect(flat(alert.get('[data-testid="error-banner-hint"]').text())).toBe(
        'Check the worker service: docker compose ps worker then docker compose logs worker',
      );
      const row = s.get('tr[data-worker="worker-1"]');
      expect(row.get('[data-kind="worker"]').text()).toBe('offline');
      expect(row.classes()).toContain('opacity-60');
      expect(flat(row.findAll('td')[4]!.text())).toBe('–');
    });
  });

  describe('first load', () => {
    it('loading: skeletons at the real layout, marked busy', async () => {
      const w = await mountPage('loading');
      expect(section('model-access').get('.tbl').attributes('aria-busy')).toBe('true');
      expect(section('model-access').findAll('[data-testid="skeleton-row"]')).toHaveLength(2);
      expect(section('secrets').findAll('[data-testid="skeleton-row"]')).toHaveLength(2);
      expect(section('workers').findAll('[data-testid="skeleton-row"]')).toHaveLength(1);
      expect(section('sandbox').find('[aria-busy="true"]').exists()).toBe(true);
      expect(w.find('[role="alert"]').exists()).toBe(false);
    });

    it("error: each section quotes the API's message with Retry", async () => {
      await mountPage('error');
      const banner = (id: string) => section(id).get('[role="alert"]');
      expect(banner('model-access').text()).toContain('Could not load model access');
      expect(banner('model-access').text()).toContain(
        'GET /api/providers → 502 · upstream api:8080 connection refused',
      );
      expect(banner('secrets').text()).toContain('Could not load secrets');
      expect(banner('sandbox').text()).toContain('Could not load the isolation report');
      expect(banner('workers').text()).toContain(
        'GET /api/system/summary → 502 · upstream api:8080 connection refused',
      );
      for (const id of ['model-access', 'secrets', 'sandbox', 'workers']) {
        expect(section(id).find('table').exists()).toBe(false);
        expect(banner(id).get('button').text()).toBe('Retry');
      }
    });

    it('Retry asks again', async () => {
      await mountPage('error');
      const load = vi.spyOn(useProvidersStore(), 'load');
      await section('model-access').get('[role="alert"] button').trigger('click');
      expect(load).toHaveBeenCalledOnce();
    });
  });
});
