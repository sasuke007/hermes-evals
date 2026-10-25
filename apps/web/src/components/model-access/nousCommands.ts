/**
 * Terminal commands the model-access components show when Nous Portal cannot be connected from
 * the UI. The host proxy's own command comes from the API (`ProviderInfo.hostCommand`).
 */

/**
 * `unavailable`: log in from a terminal instead. This is the command docker-compose.yml
 * documents for the nous-proxy service; the System board draws an older form of it
 * (`docker compose --profile nous run --rm nous-proxy auth add nous …`).
 */
export const NOUS_TERMINAL_LOGIN_COMMAND =
  'docker compose run --rm --entrypoint /opt/hermes/.venv/bin/hermes nous-proxy auth add nous --type oauth --no-browser';
