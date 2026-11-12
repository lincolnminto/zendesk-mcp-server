import { constants } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

// biome-ignore lint/suspicious/noBitwiseOperators: Node open() takes an OS flag bitmask.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node open() takes an OS flag bitmask.
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
const APPEND_FLAGS =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node open() takes an OS flag bitmask.
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
// biome-ignore lint/suspicious/noBitwiseOperators: Node open() takes an OS flag bitmask.
const TRUNCATE_FLAGS = constants.O_WRONLY | constants.O_NOFOLLOW;

export interface FileStats {
  lines: number;
  bytes: number;
}
const SEPARATORS = /[/\\]/;
export const validateResumeName = (name: string): string => {
  if (!name || name.includes('..') || SEPARATORS.test(name) || name === '.') {
    throw new Error('Resume must be a snapshot folder name without separators or ..');
  }
  return name;
};

/** Reject symlinks in every existing path component, including exportDir. */
export const safeDirectory = async (path: string, create: boolean): Promise<void> => {
  const parent = resolve(path, '..');
  if (parent !== path) await safeDirectory(parent, create);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Snapshot directories must be real local directories');
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT') || !create) throw err;
    await mkdir(path);
  }
};
export const snapshotFile = (snapshot: string, name: string): string => {
  const target = resolve(snapshot, name);
  const rel = relative(snapshot, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('File must stay inside the snapshot');
  return target;
};

export const readManifest = async <T>(snapshot: string): Promise<T> => {
  const handle = await open(join(snapshot, 'manifest.json'), READ_FLAGS);
  try {
    return JSON.parse(await handle.readFile('utf8')) as T;
  } finally {
    await handle.close();
  }
};

/** Rename commits the position and all file byte offsets together. */
export const writeManifest = async (snapshot: string, manifest: object): Promise<void> => {
  const temp = join(snapshot, 'manifest.json.tmp');
  const handle = await open(temp, WRITE_FLAGS, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, join(snapshot, 'manifest.json'));
};

export const appendPage = async (
  snapshot: string,
  file: string,
  rows: unknown[],
  previous: FileStats = { lines: 0, bytes: 0 },
): Promise<FileStats> => {
  const handle = await open(snapshotFile(snapshot, file), APPEND_FLAGS, 0o600);
  const data = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { lines: previous.lines + rows.length, bytes: previous.bytes + Buffer.byteLength(data) };
};

export const truncateFiles = async (
  snapshot: string,
  files: Record<string, FileStats>,
): Promise<void> => {
  for (const [name, stats] of Object.entries(files)) {
    if (
      !Number.isSafeInteger(stats.bytes) ||
      stats.bytes < 0 ||
      !Number.isSafeInteger(stats.lines) ||
      stats.lines < 0
    )
      throw new Error('Invalid file checkpoint');
    const target = snapshotFile(snapshot, name);
    try {
      await lstat(target);
    } catch (err) {
      if (stats.bytes === 0 && err instanceof Error && 'code' in err && err.code === 'ENOENT')
        continue;
      throw err;
    }
    const handle = await open(target, TRUNCATE_FLAGS);
    try {
      if ((await handle.stat()).size < stats.bytes)
        throw new Error('Snapshot file is shorter than its checkpoint');
      await handle.truncate(stats.bytes);
    } finally {
      await handle.close();
    }
  }
};

export const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
  const handle = await open(path, WRITE_FLAGS, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const readFileStats = async (snapshot: string, file: string): Promise<FileStats> => {
  const handle = await open(snapshotFile(snapshot, file), READ_FLAGS);
  try {
    const data = await handle.readFile();
    return {
      lines: data.reduce((count, byte) => count + Number(byte === 10), 0),
      bytes: data.length,
    };
  } finally {
    await handle.close();
  }
};
