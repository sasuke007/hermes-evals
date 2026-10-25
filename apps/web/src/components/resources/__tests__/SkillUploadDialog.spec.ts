import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import SkillUploadDialog from '../SkillUploadDialog.vue';
import { SKILL_INVOICE_METHOD_110_ID } from '@/fixtures/resources';
import { fileOfSize, footerButtons, mountResources, pickFile, zip } from './mountResources';

let w: VueWrapper | null = null;
afterEach(() => {
  w?.unmount();
  w = null;
});

async function open(scenario: string | null = null) {
  const mounted = await mountResources(SkillUploadDialog, { props: { open: true }, scenario });
  w = mounted.w;
  return mounted;
}
const text = (testid: string) => w!.get(`[data-testid="${testid}"]`).text();
const confirmButton = () => w!.get('[data-testid="confirm-upload"]');

describe('Upload skill', () => {
  it('starts at step 1 with the drop zone and Confirm disabled', async () => {
    await open();
    expect(w!.get('[role="dialog"]').attributes('aria-modal')).toBe('true');
    expect(text('step-label')).toBe('Step 1 of 2 · choose file');
    expect(text('drop-zone')).toContain('Drop a skill zip here, or choose a file');
    expect(text('drop-zone')).toContain('.zip up to 20 MB · must contain SKILL.md at its root');
    expect(w!.get('[data-testid="file-input"]').attributes('accept')).toBe('.zip,application/zip');
    expect(footerButtons(w!)).toEqual(['Cancel', 'Confirm upload']);
    expect(confirmButton().attributes('disabled')).toBeDefined();
  });

  it('reviews a valid first upload and stores it on Confirm', async () => {
    const { store } = await open();
    await pickFile(w!, zip());
    expect(text('step-label')).toBe('Step 2 of 2 · review');
    expect(text('upload-file')).toContain('invoice-method.zip');
    expect(text('upload-size')).toBe('7.6 KB');
    expect(text('upload-lead')).toBe('Valid skill · nothing stored yet');
    const checks = w!.findAll('[data-testid="upload-check"]');
    expect(checks.map((c) => c.findAll('span')[0]!.text())).toEqual([
      'SKILL.md',
      'name',
      'version',
      'description',
      'files',
      'content hash',
    ]);
    expect(checks[4]!.text()).toContain('4 files · 18.2 KB unpacked');
    expect(checks[5]!.text()).toContain('sha256:9c41e07d5f3a…b7a2');
    expect(w!.get('details summary').text()).toBe('File tree · 4 files');
    expect(text('file-tree').split('\n')[0]).toBe('invoice-method/');
    expect(confirmButton().text()).toBe('Confirm upload');
    expect(confirmButton().attributes('disabled')).toBeUndefined();

    await confirmButton().trigger('click');
    await flushPromises();
    expect(w!.emitted('update:open')?.slice(-1)[0]).toEqual([false]);
    expect(w!.emitted('uploaded')?.[0]).toEqual([store.skillRows[0]!.id]);
    expect(store.flashId).toBe(store.skillRows[0]!.id);
  });

  it('says a new version becomes 1.1.0 and confirms as "Upload as 1.1.0"', async () => {
    const { store } = await open('upload-new-version');
    await pickFile(w!, zip());
    expect(text('upload-lead')).toBe('Valid skill · nothing stored yet');
    expect(text('new-version')).toBe(
      'invoice-method 1.0.0 already exists. This upload becomes version 1.1.0 (from its SKILL.md). Configurations keep the version they reference.',
    );
    expect(confirmButton().text()).toBe('Upload as 1.1.0');
    await confirmButton().trigger('click');
    await flushPromises();
    expect(w!.emitted('uploaded')?.[0]).toEqual([SKILL_INVOICE_METHOD_110_ID]);
    expect(store.skills.byId[SKILL_INVOICE_METHOD_110_ID]?.version).toBe('1.1.0');
  });

  it('refuses the same version with other content: Confirm stays disabled', async () => {
    await open('upload-same-version-different-hash');
    await pickFile(w!, zip());
    expect(text('upload-lead')).toBe('1 problem. Nothing was stored.');
    const alert = w!.get('[data-testid="upload-problem"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toBe(
      'Version 1.0.0 already exists with a different hash. Bump version: in SKILL.md.',
    );
    const version = w!.findAll('[data-testid="upload-check"]')[2]!;
    expect(version.attributes('data-ok')).toBe('false');
    expect(w!.findAll('[data-testid="upload-check"]')[5]!.text()).toContain(
      '(stored 1.0.0: 9c41e07d)',
    );
    expect(footerButtons(w!)).toEqual(['Choose another file', 'Confirm upload']);
    expect(confirmButton().attributes('disabled')).toBeDefined();
  });

  it('lists the problems of an invalid zip and goes back to step 1', async () => {
    await open('upload-invalid');
    await pickFile(w!, zip('invoice-method-folder.zip'));
    expect(text('upload-lead')).toBe('2 problems. Nothing was stored.');
    expect(w!.findAll('[data-testid="upload-check"]')).toHaveLength(0);
    const problems = w!.get('ul[aria-label="Problems"]').findAll('[data-testid="upload-problem"]');
    expect(problems.map((p) => p.find('b').text())).toEqual([
      'No SKILL.md at the zip root.',
      'No version in metadata.',
    ]);
    expect(problems[0]!.text()).toContain(
      "Found invoice-method/SKILL.md one folder down. Zip the folder's contents rather than the folder.",
    );
    expect(confirmButton().attributes('disabled')).toBeDefined();
    await w!.findAll('[data-testid="dialog-footer"] button')[0]!.trigger('click');
    expect(text('step-label')).toBe('Step 1 of 2 · choose file');
  });

  it('refuses a zip over 20 MB without sending it', async () => {
    await open();
    await pickFile(w!, fileOfSize('huge.zip', 21 * 1024 * 1024));
    expect(text('upload-lead')).toBe('1 problem. Nothing was stored.');
    expect(w!.get('[data-testid="upload-problem"]').text()).toContain(
      '21 MB is over the 20 MB limit.',
    );
    expect(confirmButton().attributes('disabled')).toBeDefined();
  });

  it('shows a failed dry run verbatim', async () => {
    await open('error');
    await pickFile(w!, zip());
    expect(w!.get('[role="alert"]').text()).toContain(
      'POST /api/resources/skills/validate → 502 · upstream api:8080 connection refused',
    );
    expect(footerButtons(w!)).toEqual(['Choose another file', 'Confirm upload']);
  });
});
