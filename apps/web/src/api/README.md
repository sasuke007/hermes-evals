# The web data layer

Components never fetch. A page calls a function in `src/api/<domain>.ts`; that function
either calls the real API or serves a fixture. The view models are the shared contracts
(`src/api/types` re-exports `@hermes-evals/shared`), so the page is the same either way.

## Modes

| Mode     | When                                                        | What a function does                              |
| -------- | ----------------------------------------------------------- | ------------------------------------------------- |
| live     | the default: `pnpm dev`, the Compose web image              | `apiGet` / `apiSend` with the response's schema   |
| fixtures | `VITE_API_MODE=fixtures` (component tests, designed states) | `fixture(value, { request })` from `src/fixtures` |

`apiMode` (`source.ts`) says which. `?scenario=<name>` picks a designed state in fixtures
mode; `src/fixtures/scenarios.ts` lists them.

## Writing a function

`system.ts` is the example:

```ts
export function getSystemSummary(): Promise<SystemSummary> {
  if (apiMode === 'live') return apiGet('/system/summary', SystemSummarySchema);
  return fixture(systemSummaryFixture, { request: 'GET /api/system/summary' });
}
```

- **Every response is parsed** with its shared schema: `apiGet(path, Schema)`,
  `apiSend(method, path, body, Schema)`. A response that does not match throws an `ApiError`
  of kind `contract`, naming the first field that broke. There is no unparsed path.
- **Paths have no `/api` prefix** and carry their query through `withQuery(path, params)`,
  whose keys are the names the shared query schema parses (`src/api/__tests__/wire.spec.ts`
  checks them).
- **State-changing calls** go through `apiSend`: it sends JSON (or `FormData` as multipart)
  with `X-Requested-With`, which the API requires (plan 6.1). Leave the schema out for a
  204 or a body nobody reads.
- **The fixture branch** names the request it stands in for, so the `error` scenario's
  message reads like the real one.

## Errors

Every failure is an `ApiError` (`client.ts`):

| Field     | What it holds                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------- |
| `message` | `POST /api/experiments → 409 · Nous Portal is not connected`: what ErrorBanner quotes verbatim |
| `status`  | the HTTP status; 0 when nothing answered                                                       |
| `detail`  | the API's own sentence (its error body's `message`)                                            |
| `issues`  | for a 400, one per field: `{ path: 'headers.0.env', message }`; `issueFor(path)` finds one     |
| `kind`    | `http`, `network` or `contract`                                                                |

Show `err.message` in an `ErrorBanner` (`errorMessage(err)` reads any thrown value); put
`issueFor(field)` under the field it names.

## Live updates

- **Streams** (`/system/events`, `/experiments/:id/events`): `useSse(path, Schema, options)`
  from `src/composables/useSse.ts`, with the stream's `events` names, `onEvent` and
  `onReconnect`. Pass `livePath(path)` so fixtures mode streams nothing. Patch the Pinia
  records in place on each event; refetch in `onReconnect`. A stream closes while nobody can
  see it (on `pagehide`, which includes a page kept in the back/forward cache, and 10 s after
  its tab goes to the background) and opens again when the page shows, calling
  `onReconnect`: over HTTP/1.1 a browser opens six connections per host, shared by every tab,
  and streams left open in hidden pages would use them up.
- **Polling** (the experiment list every 5 s while anything runs, the inspector's events
  while the run is live): `usePolling(fn, intervalMs, enabled)` from
  `src/composables/usePolling.ts`.
