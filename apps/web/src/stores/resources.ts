/**
 * The resource library: skills, documents, MCP servers and secrets, each as records keyed by
 * id with their own load state, plus the tab counts, skill details and skill files (loaded
 * when the detail drawer opens them).
 *
 * Writes go through here so every tab stays in step: a confirmed skill, an uploaded document
 * or a saved MCP server is put into its records at once (in the API's list order) and flashes
 * on its row; the counts are read again; saving an MCP server re-reads the secrets, whose rows
 * come from the names definitions reference. A saved server's Test start records its result
 * on the row. Nothing here streams: the library changes only when the user changes it.
 */
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import {
  checkSecrets as checkSecretsApi,
  confirmSkillUpload,
  getResourceCounts,
  getSkill,
  getSkillFile,
  listDocuments,
  listMcpServers,
  listSecrets,
  listSkills,
  saveMcpServer as saveMcpServerApi,
  testMcpServer as testMcpServerApi,
  uploadDocument as uploadDocumentApi,
  validateSkillUpload,
} from '@/api/resources';
import { errorMessage } from '@/api/client';
import type {
  DocumentRow,
  McpServerInput,
  McpServerRow,
  McpTestView,
  ResourceCounts,
  ResourceTab,
  SecretRow,
  SkillDetail,
  SkillFileContent,
  SkillRow,
  SkillUploadValidation,
} from '@/api/types/resources';

/** How long an added or saved row flashes (the boards' he-flash, 2 s). */
export const FLASH_MS = 2_000;

/** One kind of resource: rows keyed by id, their order, and how the last load went. */
export interface ResourceCollection<T> {
  byId: Record<string, T>;
  ids: string[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

function collection<T>(): ResourceCollection<T> {
  return { byId: {}, ids: [], loading: false, loaded: false, error: null };
}

/** The API's list order for each kind (skills.service, documents.service, mcp-reads). */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const SKILL_ORDER = (a: SkillRow, b: SkillRow) =>
  byText(a.name, b.name) || byText(b.uploadedAt, a.uploadedAt);
const DOCUMENT_ORDER = (a: DocumentRow, b: DocumentRow) =>
  byText(a.filename, b.filename) || byText(b.uploadedAt, a.uploadedAt);
const MCP_ORDER = (a: McpServerRow, b: McpServerRow) => byText(a.name, b.name);

/** A secret is one row per name and source (a name read by both is two rows). */
export const secretKey = (row: Pick<SecretRow, 'name' | 'source'>): string =>
  `${row.source}:${row.name}`;

/** Detail and file loads, keyed by skill id (and `id/path` for files). */
interface Lookup<T> {
  value: T | null;
  loading: boolean;
  error: string | null;
}

export const useResourcesStore = defineStore('resources', () => {
  const counts = ref<ResourceCounts | null>(null);
  const skills = reactive(collection<SkillRow>()) as ResourceCollection<SkillRow>;
  const documents = reactive(collection<DocumentRow>()) as ResourceCollection<DocumentRow>;
  const mcpServers = reactive(collection<McpServerRow>()) as ResourceCollection<McpServerRow>;
  const secrets = reactive(collection<SecretRow>()) as ResourceCollection<SecretRow>;
  const skillDetails = reactive<Record<string, Lookup<SkillDetail>>>({});
  const skillFiles = reactive<Record<string, Lookup<SkillFileContent>>>({});
  /** The id of the row that was just added or saved; it flashes for FLASH_MS. */
  const flashId = ref<string | null>(null);
  /** "Check again" on the Secrets tab is reading. */
  const checking = ref(false);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const rowsOf = <T>(c: ResourceCollection<T>): T[] =>
    c.ids.map((id) => c.byId[id]).filter((row): row is T => row !== undefined);
  const skillRows = computed(() => rowsOf(skills));
  const documentRows = computed(() => rowsOf(documents));
  const mcpServerRows = computed(() => rowsOf(mcpServers));
  const secretRows = computed(() => rowsOf(secrets));

  function replaceAll<T>(c: ResourceCollection<T>, rows: T[], key: (row: T) => string): void {
    c.byId = Object.fromEntries(rows.map((row) => [key(row), row]));
    c.ids = rows.map(key);
    c.loaded = true;
    c.error = null;
  }

  /** Puts a row in place (same id) or at its place in the API's order (a new id). */
  function upsert<T>(
    c: ResourceCollection<T>,
    row: T,
    key: (row: T) => string,
    order: (a: T, b: T) => number,
  ): void {
    const id = key(row);
    const known = id in c.byId;
    c.byId = { ...c.byId, [id]: row };
    if (known) return;
    const rows = [...rowsOf(c), row].sort(order);
    c.ids = rows.map(key);
  }

  async function loadInto<T>(
    c: ResourceCollection<T>,
    fetchRows: () => Promise<T[]>,
    key: (row: T) => string,
  ): Promise<void> {
    c.loading = true;
    try {
      replaceAll(c, await fetchRows(), key);
    } catch (err) {
      c.error = errorMessage(err);
    } finally {
      c.loading = false;
    }
  }

  function flash(id: string): void {
    flashId.value = id;
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashId.value = null;
      flashTimer = null;
    }, FLASH_MS);
  }

  // ── loaders ─────────────────────────────────────────────────────────────
  /** The tab counts; a failure leaves the last counts (the tabs then show none). */
  async function loadCounts(): Promise<void> {
    try {
      counts.value = await getResourceCounts();
    } catch {
      /* the tab's own load reports the failure */
    }
  }
  const loadSkills = () => loadInto(skills, listSkills, (r) => r.id);
  const loadDocuments = () => loadInto(documents, listDocuments, (r) => r.id);
  const loadMcpServers = () => loadInto(mcpServers, listMcpServers, (r) => r.id);
  const loadSecrets = () => loadInto(secrets, listSecrets, secretKey);

  /** Loads what a tab shows, and the counts. The MCP tab also reads secrets (the form's "is set"). */
  async function loadTab(tab: ResourceTab): Promise<void> {
    const loads: Promise<void>[] = [loadCounts()];
    if (tab === 'skills') loads.push(loadSkills());
    if (tab === 'documents') loads.push(loadDocuments());
    if (tab === 'mcp') loads.push(loadMcpServers(), loadSecrets());
    if (tab === 'secrets') loads.push(loadSecrets());
    await Promise.all(loads);
  }

  /** "Check again": the worker and egress report their names now. */
  async function checkSecrets(): Promise<void> {
    checking.value = true;
    try {
      replaceAll(secrets, await checkSecretsApi(), secretKey);
    } catch (err) {
      secrets.error = errorMessage(err);
    } finally {
      checking.value = false;
    }
  }

  // ── skills ──────────────────────────────────────────────────────────────
  async function loadSkillDetail(id: string): Promise<void> {
    skillDetails[id] ??= { value: null, loading: false, error: null };
    // Through the reactive record, so the drawer sees each change.
    const entry = skillDetails[id];
    entry.loading = true;
    entry.error = null;
    try {
      entry.value = await getSkill(id);
    } catch (err) {
      entry.error = errorMessage(err);
    } finally {
      entry.loading = false;
    }
  }

  const fileKey = (id: string, path: string): string => `${id}/${path}`;

  /** One file of a skill; read once, then kept. */
  async function loadSkillFile(id: string, path: string): Promise<void> {
    const key = fileKey(id, path);
    if (skillFiles[key]?.value || skillFiles[key]?.loading) return;
    skillFiles[key] ??= { value: null, loading: false, error: null };
    const entry = skillFiles[key];
    entry.loading = true;
    entry.error = null;
    try {
      entry.value = await getSkillFile(id, path);
    } catch (err) {
      entry.error = errorMessage(err);
    } finally {
      entry.loading = false;
    }
  }

  function skillFile(id: string, path: string): Lookup<SkillFileContent> | null {
    return skillFiles[fileKey(id, path)] ?? null;
  }

  /** Step 1 of 2: nothing is stored. Errors (413, a network failure) are thrown to the dialog. */
  function validateSkill(file: File): Promise<SkillUploadValidation> {
    return validateSkillUpload(file);
  }

  /** Step 2 of 2: stores the skill, adds its row and flashes it. */
  async function confirmSkill(token: string): Promise<SkillRow> {
    const row = await confirmSkillUpload(token);
    upsert(skills, row, (r) => r.id, SKILL_ORDER);
    flash(row.id);
    void loadCounts();
    return row;
  }

  // ── documents ───────────────────────────────────────────────────────────
  async function uploadDocument(file: File): Promise<DocumentRow> {
    const row = await uploadDocumentApi(file);
    upsert(documents, row, (r) => r.id, DOCUMENT_ORDER);
    flash(row.id);
    void loadCounts();
    return row;
  }

  // ── MCP servers ─────────────────────────────────────────────────────────
  /** New (no id) or edit; a frozen server comes back as its next version under the same id. */
  async function saveMcpServer(input: McpServerInput, id?: string): Promise<McpServerRow> {
    const row = await saveMcpServerApi(input, id);
    upsert(mcpServers, row, (r) => r.id, MCP_ORDER);
    flash(row.id);
    void loadCounts();
    void loadSecrets();
    return row;
  }

  /** Test start. A saved server's result is recorded on its version, so the row shows it too. */
  async function testMcpServer(target: { id: string } | McpServerInput): Promise<McpTestView> {
    const result = await testMcpServerApi(target);
    if ('id' in target) {
      const row = mcpServers.byId[target.id];
      if (row) mcpServers.byId = { ...mcpServers.byId, [target.id]: { ...row, lastTest: result } };
    }
    return result;
  }

  /** The worker's (stdio) or egress's (http) row for a name, when a definition references it. */
  function secretFor(name: string, source: SecretRow['source']): SecretRow | null {
    return secrets.byId[secretKey({ name, source })] ?? null;
  }

  return {
    counts,
    skills,
    documents,
    mcpServers,
    secrets,
    skillRows,
    documentRows,
    mcpServerRows,
    secretRows,
    skillDetails,
    flashId,
    checking,
    loadCounts,
    loadSkills,
    loadDocuments,
    loadMcpServers,
    loadSecrets,
    loadTab,
    checkSecrets,
    loadSkillDetail,
    loadSkillFile,
    skillFile,
    validateSkill,
    confirmSkill,
    uploadDocument,
    saveMcpServer,
    testMcpServer,
    secretFor,
  };
});
