/**
 * Configurations: list, detail (any version), diff, form options, the form's
 * starting draft (new, edit, duplicate) and save. Saving an edit of a version
 * experiments used creates the next version; nothing else changes.
 *
 * Fixtures by default (src/fixtures/configurations.ts); VITE_API_MODE=live
 * calls the planned endpoints of plan section 11.
 */
import type {
  ConfigDiff,
  ConfigurationDetail,
  ConfigurationDraft,
  ConfigurationFormOptions,
  ConfigurationInput,
  ConfigurationListRow,
  ConfigurationSaveResult,
} from './types/configurations';
import {
  apiMode,
  fixture,
  fixtureFailure,
  hasScenario,
  liveGet,
  liveSend,
  notFound,
  withQuery,
} from './source';
import {
  CONFIG_FIELDS,
  CONFIG_VERSIONS,
  configDiffFixture,
  configurationsFixture,
  DUPLICATED_FROM,
  draftFixture,
  findConfigVersion,
  formOptionsFixture,
  versionRef,
  type ConfigName,
} from '@/fixtures/configurations';
import { configurationUsageFixture } from '@/fixtures/experiments';
import { ulid } from '@/fixtures/suites';

export { CONFIG_FIELDS };

const noConfigurations = () => hasScenario('empty') || hasScenario('first-launch');

/** GET /configurations: one row per configuration, at its latest version. */
export function listConfigurations(): Promise<ConfigurationListRow[]> {
  if (apiMode === 'live') return liveGet('/configurations');
  return fixture(
    () =>
      configurationsFixture(noConfigurations()).map((latest) => ({
        id: latest.configurationId,
        name: latest.name,
        createdAt: latest.createdAt,
        latest,
        usedInExperiments: configurationUsageFixture(hasScenario, latest.configurationId).length,
      })),
    { request: 'GET /api/configurations' },
  );
}

/**
 * GET /configurations/:id, or GET /configurations/:id/versions/:v when
 * `version` is given ("view as of this experiment" opens a frozen version).
 */
export function getConfiguration(id: string, version?: number): Promise<ConfigurationDetail> {
  const path =
    version === undefined ? `/configurations/${id}` : `/configurations/${id}/versions/${version}`;
  if (apiMode === 'live') return liveGet(path);
  const request = `GET /api/configurations/${id}`;
  return fixture(
    () => {
      const latest = noConfigurations() ? undefined : findConfigVersion(id);
      if (!latest || (version !== undefined && version !== latest.version)) {
        throw notFound(
          request,
          `configuration ${id}${version === undefined ? '' : ` v${version}`}`,
        );
      }
      const sourceName = DUPLICATED_FROM[latest.name as ConfigName];
      const source = sourceName ? CONFIG_VERSIONS[sourceName] : null;
      return {
        id: latest.configurationId,
        name: latest.name,
        createdAt: latest.createdAt,
        shown: latest,
        latest,
        versions: [latest],
        duplicatedFrom: source ? versionRef(source) : null,
        differsFromSource: source ? configDiffFixture([source, latest]).differing : [],
        usedIn: configurationUsageFixture(hasScenario, latest.configurationId),
      };
    },
    { request },
  );
}

/** GET /configurations/diff?versions=a,b,c: ConfigDiffTable rows; the first column is the reference. */
export function diffConfigurations(versionIds: string[]): Promise<ConfigDiff> {
  if (apiMode === 'live') {
    return liveGet(withQuery('/configurations/diff', { versions: versionIds }));
  }
  const request = 'GET /api/configurations/diff';
  return fixture(
    () => {
      const versions = versionIds.map((v) => {
        const found = findConfigVersion(v);
        if (!found) throw notFound(request, `configuration version ${v}`);
        return found;
      });
      return configDiffFixture(versions);
    },
    { request },
  );
}

/**
 * Models (price table), providers, the 17 runtime toolsets, and the skills,
 * documents and MCP servers a configuration can include.
 * Live: GET /configurations/form-options (backed by /system/summary and the resource lists).
 */
export function getConfigurationFormOptions(): Promise<ConfigurationFormOptions> {
  if (apiMode === 'live') return liveGet('/configurations/form-options');
  return fixture(() => formOptionsFixture(noConfigurations()), {
    request: 'GET /api/configurations/form-options',
  });
}

/**
 * The form's starting point. `edit` of a version experiments used says that
 * saving creates the next version and which experiments keep this one;
 * `duplicate` prefills from another configuration (POST /configurations/:id/duplicate).
 */
export function getConfigurationDraft(
  mode: ConfigurationDraft['mode'],
  id?: string,
): Promise<ConfigurationDraft> {
  if (apiMode === 'live') {
    if (mode === 'duplicate' && id) return liveSend('POST', `/configurations/${id}/duplicate`);
    if (mode === 'edit' && id) return liveGet(`/configurations/${id}/draft`);
    return Promise.resolve(draftFixture('new', null));
  }
  const request =
    mode === 'duplicate'
      ? `POST /api/configurations/${id}/duplicate`
      : `GET /api/configurations/${id ?? 'new'}`;
  return fixture(
    () => {
      if (mode === 'new' || !id) return draftFixture('new', null);
      const source = findConfigVersion(id);
      if (!source) throw notFound(request, `configuration ${id}`);
      const draft = draftFixture(mode, source);
      if (mode === 'edit') {
        draft.experimentsKeepingVersion = configurationUsageFixture(
          hasScenario,
          source.configurationId,
        ).map((u) => ({ id: u.experimentId, name: u.experimentName }));
      }
      return draft;
    },
    { request },
  );
}

/**
 * POST /configurations (new) or PUT /configurations/:id (edit). An edit of a
 * frozen version creates the next version ("Saved as version 2"); the page
 * routes to the detail. A taken name is a 409.
 */
export function saveConfiguration(
  input: ConfigurationInput,
  id?: string,
): Promise<ConfigurationSaveResult> {
  if (apiMode === 'live') {
    return id
      ? liveSend('PUT', `/configurations/${id}`, input)
      : liveSend('POST', '/configurations', input);
  }
  const request = id ? `PUT /api/configurations/${id}` : 'POST /api/configurations';
  const existing = id ? findConfigVersion(id) : undefined;
  const clash = Object.values(CONFIG_VERSIONS).find(
    (c) => c.name === input.name.trim() && c.configurationId !== existing?.configurationId,
  );
  if (clash) {
    return fixtureFailure(request, 409, `a configuration named ${clash.name} already exists`);
  }
  return fixture(
    () => {
      if (id && !existing) throw notFound(request, `configuration ${id}`);
      if (existing) {
        const frozen = existing.frozenAt !== null;
        const version = frozen ? existing.version + 1 : existing.version;
        return {
          configurationId: existing.configurationId,
          versionId: frozen
            ? ulid('cfgv', `${existing.configurationId}:${version}`)
            : existing.versionId,
          version,
          createdNewVersion: frozen,
        };
      }
      return {
        configurationId: ulid('cfg', input.name),
        versionId: ulid('cfgv', `${input.name}:1`),
        version: 1,
        createdNewVersion: true,
      };
    },
    { request },
  );
}
