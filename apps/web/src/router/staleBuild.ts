/**
 * A page left open across a redeploy, or an index.html a browser kept from an older build,
 * asks for build files that are gone (their names carry the build's hashes). A lazy route then
 * fails with "Failed to fetch dynamically imported module" and the page would stay blank, so
 * the router loads the address again, once, which fetches the current build. A second failure
 * for the same address is left alone, so a file that is really missing cannot loop.
 * docker/nginx.conf keeps index.html from being cached and answers 404 for a missing file.
 */
export const STALE_BUILD_RELOAD_KEY = 'hermes-evals.stale-build-reload';

/** Chrome, Firefox and Safari's words for a lazy chunk that could not be loaded. */
const STALE_CHUNK =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

export function isStaleBuildError(err: unknown): boolean {
  return err instanceof Error && STALE_CHUNK.test(err.message);
}

type ReloadStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): ReloadStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Reloads `path` for a stale-build error, once per address; says whether it did. */
export function reloadForStaleBuild(
  err: unknown,
  path: string,
  navigate: (url: string) => void = (url) => window.location.assign(url),
  store: Pick<Storage, 'getItem' | 'setItem'> | null = sessionStore(),
): boolean {
  if (!isStaleBuildError(err)) return false;
  try {
    if (store?.getItem(STALE_BUILD_RELOAD_KEY) === path) return false;
    store?.setItem(STALE_BUILD_RELOAD_KEY, path);
  } catch {
    /* storage unavailable: reload anyway, the browser stops a tight loop */
  }
  navigate(path);
  return true;
}

/** After a navigation succeeds, a later stale build may reload again. */
export function clearStaleBuildReload(
  store: Pick<Storage, 'removeItem'> | null = sessionStore(),
): void {
  try {
    store?.removeItem(STALE_BUILD_RELOAD_KEY);
  } catch {
    /* storage unavailable */
  }
}
