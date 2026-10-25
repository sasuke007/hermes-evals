# Building pages in apps/web

Vue 3.5 (`<script setup lang="ts">`), vue-router, Pinia, Tailwind CSS v4 over the design
tokens, zod contracts from `@hermes-evals/shared`. This note is for whoever builds a page:
where things go, how to style them so they match the boards, and how to test them.

## Where things go

| Path                         | What lives there                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/views/<domain>/`        | Route pages. Keep the props the router passes (`src/router/index.ts`).                                                                                                 |
| `src/components/<domain>/`   | Components of one domain: `experiment-list`, `new-experiment`, `overview`, `comparison`, `runs`, `inspector`, `configurations`, `suites`, `resources`, `model-access`. |
| `src/components/ui/`         | Shared primitives (below). Use them before writing your own; extend them only for what a board shows.                                                                  |
| `src/components/layout/`     | `AppShell`, `PageContainer`.                                                                                                                                           |
| `src/api/<domain>.ts`        | The data layer: live or fixtures. See `src/api/README.md`.                                                                                                             |
| `src/stores/<domain>.ts`     | Pinia stores: records keyed by id, loaders, in-place patches from live events.                                                                                         |
| `src/composables/`           | `useSse`, `usePolling`, `useUrlState`, `useKeyboardGrid`, `useFocusTrap`.                                                                                              |
| `src/lib/`                   | `statusTones.ts` (every status colour), `format.ts` (numbers, counts, sizes, hashes, times), `textSegments.ts`.                                                        |
| `__tests__/` beside the code | Vitest specs.                                                                                                                                                          |

A component that two domains use moves to `ui/`, or stays with the domain that owns its
data (`suites/NewerSuiteNotice` is the Overview's notice about a newer suite version). Pure
helpers shared by pages go to `src/lib/` (`plural`, `formatBytes`, `formatSha256` and the
rest of `format.ts`), never a copy per domain.

Shared primitives in `src/components/ui` (single-word ones carry the `Base` prefix, as the
Vue style guide and the lint rule want): `BaseInput`, `TextArea`, `BaseSelect`, `BaseToggle`
(a switch), `ToggleButton` (aria-pressed filter or chip), `FormField`, `SegmentedControl`,
`TabNav`, `DataTable`, `SkeletonRows`, `EmptyState`, `ErrorBanner`, `ConfirmInline`,
`StatusChip`, `StatusDot`, `BaseTag`, `LiveIndicator`, `CopyButton`, `CopyCommand`,
`CodeBlock`, `JsonBlock`, `IntervalBar`, `ProgressBar`, `KeyValueList`, `BasePanel`,
`PanelHeader`, `PageHeader`, `BaseBreadcrumb`, `BaseTooltip`, `BaseDialog`, `BaseDrawer`.
Each file's header comment says what it is for and which board draws it. Buttons are the
`btn` classes on a `<button>` or a `RouterLink`, and checkboxes are native
(`<input type="checkbox" class="size-14 accent-accent">`): neither needs a component.

## Styling

One stylesheet, `src/assets/app.css`: Tailwind with the tokens of `src/assets/tokens.css`
mapped into its theme. Style with utilities in the template. No `<style scoped>`: unlayered
CSS beats every utility, so it breaks overrides. No raw colours: only the tokens exist.

- **Spacing is in pixels.** One step is 1px: `p-12` is 12px, `gap-6` 6px, `h-32` 32px,
  `max-w-1440` 1440px. Copy the board's numbers as they are.
- **Colours** are the tokens: `bg-bg`, `bg-surface`, `bg-surface-2`, `bg-surface-3`,
  `border-border`, `border-border-strong`, `text-text`, `text-text-2`, `text-text-3`,
  `bg-accent`, `hover:bg-accent-hover`, `bg-accent-soft`, `text-on-accent`, `bg-scrim`, and per
  tone (`pass`, `fail`, `err`, `ung`, `run`, `que`) the solid, `-soft` and `-text` forms:
  `bg-fail-soft text-fail-text border-fail`. They switch with the theme by themselves; `dark:`
  (keyed on `data-theme`) is almost never needed. A bare `border` is the 1px `--border` line.
- **Status colours come from `src/lib/statusTones.ts`**: `<StatusChip kind="run" :status>`, or
  `TONE_CLASSES[tone].chip` / `.solid` / `.text` / `.border` / `.ring`. Do not pick tones by hand.
- **Type scale**: `text-11` (micro, 11/16), `text-12` (small, 12/16), `text-13` (body, 13/20,
  the default), `text-14`, `text-15` (headings, 15/22), `text-17`, `text-20` (page title,
  20/28), `text-24`, `text-28` (display, 28/36). `font-mono` for ids, keys, paths, values.
  Where a board sets only `font-size:12px` on a block element, it inherits a 20px line:
  write `text-12 leading-20` (mono blocks are `text-12 leading-18`).
- **Radii**: `rounded-2` cells, `rounded-3` chips, `rounded-4` controls, `rounded-6` panels,
  `rounded-8` dialogs and drawers. **Shadow**: `shadow-float`, only on what floats.
- **Motion**: `animate-live` (the pulse; only running and scoring), `animate-spin`,
  `animate-shimmer` (skeletons), `animate-arrive` (a new feed row), `animate-flash` (an
  uploaded row). Reduced motion stops them all.
- **The few component classes**, named as on the canvas so board markup ports as written:
  `btn` with `primary`, `ghost`, `danger` and `sm` (26px), `mid` (28px), `lg`; `linkbtn`;
  `chip` (`sm`); `tag`; `input` (`sm`, `warn`, `aria-invalid`); `tbl` around `table.dt` with
  `compact`, `h30`, `h36`, `h38`, `h40`, `h44`, `th30`, `inset14`, `loose`, `wrap`, `static`,
  `clickable`. Utilities on the same element win: `class="btn primary h-28"`.

### The page frame

Every page renders `PageContainer` and starts with `PageHeader`:

```vue
<PageContainer variant="detail">
  <PageHeader
    :title="experiment.name"
    :breadcrumbs="[{ label: 'Experiments', to: { name: ROUTE_NAMES.experiments } }, { label: experiment.name }]"
  >
    <template #title-extra><StatusChip kind="experiment" :status="experiment.status" /></template>
    <template #actions><RouterLink class="btn primary" :to="duplicateLink">Duplicate</RouterLink></template>
  </PageHeader>
  …
</PageContainer>
```

| Variant  | Boards                                         | Utilities                                                          |
| -------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| `list`   | Experiments, Configurations, Suites, Resources | `mx-auto flex w-full max-w-1440 flex-col gap-16 p-24 max-xl:px-16` |
| `detail` | any page with a breadcrumb                     | `… gap-16 px-24 pt-20 pb-48 max-xl:px-16` (Runs: `gap="14"`)       |
| `system` | System                                         | `… gap-28 px-24 pt-24 pb-48 max-xl:px-16`                          |

Inside: blocks 16px apart (28 between System's sections and the inspector's), groups in
`BasePanel` (`title` draws its `PanelHeader`, 12px 16px, with a caption or actions on the right),
labels and values in `KeyValueList`, a section heading as
`<h2 class="text-15 font-semibold">`. Side-by-side columns wrap rather than shrink: the boards
use `flex flex-wrap gap-16` with `flex-[999_1_640px] min-w-0` for the main column and a fixed
side column (360px, 300px from 1024 to 1279px). Below 1024px everything is one column and
the drawer is full width; nothing hides behind a menu.

## Reading a board

The canvas is downloaded under the session scratchpad (`…/artifact-files/<id>/project`);
`canvas.json` lists every board with its page and title. A board `X.dc.html` is HTML with
inline styles plus a `<script>` whose `renderVals()` holds its states, copy and sample data:
read both. The `<helmet>` block defines the board's classes; most are the canvas classes
above. Translate the rest like this:

| Board                                               | Here                                                           |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `display:flex;gap:8px;align-items:center`           | `flex items-center gap-8`                                      |
| `padding:12px 16px` / `margin-top:6px`              | `px-16 py-12` / `mt-6`                                         |
| `color:var(--text-2)`, `.t2`, `.t3`                 | `text-text-2`, `text-text-3`                                   |
| `.cap`, `.help`                                     | `text-12 text-text-3`                                          |
| `.mono`, `font-size:12px` on mono                   | `font-mono`, `font-mono text-12`                               |
| `.panel` / `.ph`                                    | `BasePanel` / `PanelHeader`                                    |
| `.chip` with a status tone                          | `StatusChip` (any other chip: `chip` + `TONE_CLASSES[t].chip`) |
| `.dot`, hollow, pulse                               | `StatusDot`                                                    |
| `.btn`, `.in`, `.field`                             | `.btn`; `.input`; `FormField` / `BaseInput`                    |
| `select.in`, checkbox, `.switch`, `.toggle`, `.tog` | `BaseSelect`, a native checkbox, `BaseToggle`, `ToggleButton`  |
| `.seg`, `.tabs`/`.tab`                              | `SegmentedControl`, `TabNav`                                   |
| `.tbl` + `table.dt`                                 | `DataTable` (or the classes, for a table of its own)           |
| `.dl`, `<dl>` grids                                 | `KeyValueList` (`rows`, `grid`, `inline`)                      |
| `.code`, JSON with "extracted"                      | `CodeBlock`, `JsonBlock`                                       |
| `.dlg*`, `.drawer`/`.dh`/`.db`, `.tip`              | `BaseDialog`, `BaseDrawer`, `BaseTooltip`                      |
| `.sk` rows                                          | `SkeletonRows` (DataTable draws them when `loading`)           |
| a confirm step                                      | `ConfirmInline` (never `alert`, `confirm` or `prompt`)         |
| numbers, durations, money, ids                      | `src/lib/format.ts`                                            |

Copy is word for word: labels, sentences, empty states, errors. Every board is drawn in
light and dark (the toggle on the board, or the `…Dark` boards); check both in the browser
with the AppShell's theme toggle. Where a board and the API contract disagree, the
contract wins and the difference goes in your report.

## Accessibility

Keyboard paths as designed: arrow keys in grids (`useKeyboardGrid`), J/K in the inspector,
Esc closes an overlay and focus returns to what opened it (`BaseDialog`, `BaseDrawer`,
`useFocusTrap`).
Every icon-only button has an `aria-label` and a `title`; a disabled control says why
(`BlockedReason`, `BaseTooltip`). Focus stays visible (2px
`--focus` ring, from the base styles).

## Tests

Vitest with `@vue/test-utils` and jsdom, in `__tests__/` beside the code. Under Vitest the
data layer serves fixtures (`vitest.config.ts` sets `VITE_API_MODE=fixtures`), with no
latency, so a page test needs no network:

```ts
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import ConfigurationListPage from '@/views/configurations/ConfigurationListPage.vue';

it('lists the configurations with their usage', async () => {
  useScenario(null); // or a designed state: useScenario('empty')
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/configurations');
  const w = mount(ConfigurationListPage, {
    global: { plugins: [createPinia(), router] },
    attachTo: document.body,
  });
  await flushPromises();
  expect(w.findAll('tbody tr')).toHaveLength(3);
  expect(w.get('h1').text()).toBe('Configurations');
});
```

- Find elements by role, label, text or `data-testid`, never by utility classes.
- `?scenario=` states (`src/fixtures/scenarios.ts`) are the designed states: `loading`,
  `error`, `empty`, and the domain ones.
- Timers: `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync` for polling and countdowns.
- Streams: pass `eventSource: fakeFactory` from `src/composables/__tests__/fakeEventSource.ts`
  to `useSse`, or stub the global `EventSource`, then `FakeEventSource.last.open()` and
  `.emit('run', event)`.
- Live mode: `vi.stubEnv('VITE_API_MODE', 'live')`, `vi.resetModules()` and a stubbed
  `fetch`, as `src/api/__tests__/wire.spec.ts` does, to check what a page sends.

Run, scoped to your paths while others are mid-edit:

```sh
pnpm --filter @hermes-evals/web exec vitest run src/views/configurations src/components/configurations
pnpm --filter @hermes-evals/web typecheck
pnpm --filter @hermes-evals/web lint
```

`pnpm dev` runs against the API on `localhost:3000` (`VITE_API_PROXY` moves it);
`VITE_API_MODE=fixtures pnpm dev` runs on fixtures, where `?scenario=` works.
