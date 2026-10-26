import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import DocumentUploadDialog from '../DocumentUploadDialog.vue';
import { fileOfSize, footerButtons, mountResources, pickFile } from './mountResources';

let w: VueWrapper | null = null;
afterEach(() => {
  w?.unmount();
  w = null;
});

async function open(props: Record<string, unknown> = {}, scenario: string | null = null) {
  const mounted = await mountResources(DocumentUploadDialog, {
    path: '/resources/documents',
    props: { open: true, ...props },
    scenario,
  });
  w = mounted.w;
  await flushPromises();
  return mounted;
}
const text = (testid: string) => w!.get(`[data-testid="${testid}"]`).text();
const confirmButton = () => w!.get('[data-testid="confirm-upload"]');
const pdf = () => new File(['%PDF-1.7'], 'vendor-policy-v3.pdf', { type: 'application/pdf' });

describe('Upload document', () => {
  it('starts at step 1: drop a file, or choose one', async () => {
    await open();
    expect(text('step-label')).toBe('Step 1 of 2 · choose file');
    expect(text('drop-zone')).toContain('Drop a file here, or choose one');
    expect(text('drop-zone')).toContain(
      'PDF, Markdown, text or CSV recommended · any file up to 50 MB',
    );
    expect(confirmButton().attributes('disabled')).toBeDefined();
  });

  it('reviews a valid document with its content hash, and stores it on Confirm', async () => {
    const { store } = await open();
    await pickFile(w!, pdf());
    // The browser hashes the file (SubtleCrypto) before the review lists it.
    await vi.waitFor(() => expect(text('document-review')).toContain('content hash'));
    expect(text('step-label')).toBe('Step 2 of 2 · review');
    expect(text('upload-lead')).toBe('Valid document · nothing stored yet');
    const review = text('document-review');
    expect(review).toContain('vendor-policy-v3.pdf');
    expect(review).toContain('PDF');
    // sha256 of "%PDF-1.7", computed by the browser before anything is sent.
    expect(review).toMatch(/content hash\s*sha256:[0-9a-f]{8}…[0-9a-f]{4}/);
    expect(review).toContain("none yet · add it from a configuration's Documents field");
    expect(footerButtons(w!)).toEqual(['Cancel', 'Confirm upload']);
    await confirmButton().trigger('click');
    await flushPromises();
    expect(w!.emitted('update:open')?.slice(-1)[0]).toEqual([false]);
    expect(store.documentRows.map((d) => d.filename)).toEqual(['vendor-policy-v3.pdf']);
  });

  it('opens at step 2 with a file dropped on the tab', async () => {
    await open({ initialFile: pdf(), open: false });
    await w!.setProps({ open: true });
    await flushPromises();
    expect(text('step-label')).toBe('Step 2 of 2 · review');
    expect(text('upload-file')).toContain('vendor-policy-v3.pdf');
  });

  it('refuses a file over 50 MB', async () => {
    await open();
    await pickFile(w!, fileOfSize('ledger-export-2026.csv', 72.4 * 1024 * 1024, 'text/csv'));
    expect(text('upload-size')).toBe('72.4 MB');
    expect(text('upload-lead')).toBe('1 problem. Nothing was stored.');
    expect(text('upload-problem')).toBe(
      '72.4 MB is over the 50 MB limit. Split the file, or keep only the columns the agent needs.',
    );
    expect(footerButtons(w!)).toEqual(['Choose another file', 'Confirm upload']);
    expect(confirmButton().attributes('disabled')).toBeDefined();
  });

  it('accepts any type, as the API does: a zip with a note (Phase 5 question 9)', async () => {
    const { store } = await open();
    await pickFile(w!, fileOfSize('invoice-scans.zip', 3.2 * 1024 * 1024, 'application/zip'));
    expect(text('upload-lead')).toBe('Valid document · nothing stored yet');
    expect(w!.find('[data-testid="upload-problem"]').exists()).toBe(false);
    expect(text('document-note')).toBe(
      'A ZIP archive is stored as one file: the agent gets the archive, not what is in it. Skills are uploaded as .zip on the Skills tab.',
    );
    expect(confirmButton().attributes('disabled')).toBeUndefined();
    await confirmButton().trigger('click');
    await flushPromises();
    expect(store.documentRows.map((d) => d.filename)).toEqual(['invoice-scans.zip']);
  });

  it('accepts a type the hint does not name, with no note', async () => {
    await open();
    await pickFile(w!, new File(['<xml/>'], 'rates.xml', { type: 'application/xml' }));
    expect(text('upload-lead')).toBe('Valid document · nothing stored yet');
    expect(w!.find('[data-testid="document-note"]').exists()).toBe(false);
    expect(confirmButton().attributes('disabled')).toBeUndefined();
  });

  it('keeps the dialog open with the API refusal', async () => {
    await open({}, 'error');
    await pickFile(w!, pdf());
    await confirmButton().trigger('click');
    await flushPromises();
    expect(w!.get('[role="alert"]').text()).toContain(
      'POST /api/resources/documents → 502 · upstream api:8080 connection refused',
    );
    expect(w!.find('[role="dialog"]').exists()).toBe(true);
  });
});
