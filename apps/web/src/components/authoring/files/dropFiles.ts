/**
 * The files a drop holds, folders included ("Drop files or a folder"): each file with its
 * path relative to what was dropped (`docs/payment-terms.pdf`), read through the browser's
 * file-system entries where it has them, else the plain file list.
 */

export interface DroppedFile {
  file: File;
  /** Relative to the drop: `invoices.csv`, `docs/payment-terms.pdf`. */
  path: string;
}

const isFile = (e: FileSystemEntry): e is FileSystemFileEntry => e.isFile;
const isDirectory = (e: FileSystemEntry): e is FileSystemDirectoryEntry => e.isDirectory;

async function walk(entry: FileSystemEntry, prefix: string, out: DroppedFile[]): Promise<void> {
  if (isFile(entry)) {
    const file = await new Promise<File>((ok, fail) => entry.file(ok, fail));
    out.push({ file, path: `${prefix}${entry.name}` });
    return;
  }
  if (!isDirectory(entry)) return;
  const reader = entry.createReader();
  // readEntries answers in batches until it answers an empty one.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

export async function droppedFiles(data: DataTransfer | null): Promise<DroppedFile[]> {
  if (!data) return [];
  const entries: FileSystemEntry[] = [];
  for (const item of data.items ?? []) {
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return [...data.files].map((file) => ({ file, path: file.name }));
  const out: DroppedFile[] = [];
  for (const entry of entries) await walk(entry, '', out);
  return out;
}
