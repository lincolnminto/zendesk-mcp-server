import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendPage,
  readManifest,
  safeDirectory,
  snapshotFile,
  truncateFiles,
  validateResumeName,
  writeJsonFile,
  writeManifest,
} from '../../../src/export/ndjson';

const folder = () => mkdtemp(join(tmpdir(), 'ndjson-'));

describe('NDJSON checkpoints', () => {
  it('counts UTF-8 bytes, appends pages and atomically replaces manifests', async () => {
    const root = await folder();
    const first = await appendPage(root, 'users.ndjson', [{ name: 'João' }]);
    expect(first).toEqual({ lines: 1, bytes: Buffer.byteLength('{"name":"João"}\n') });
    const second = await appendPage(root, 'users.ndjson', [{ id: 2 }], first);
    await writeManifest(root, { files: second });
    await writeManifest(root, { files: first });
    expect(await readManifest(root)).toEqual({ files: first });
    await truncateFiles(root, { 'users.ndjson': first });
    expect(await readFile(join(root, 'users.ndjson'), 'utf8')).toMatchInlineSnapshot(`
      "{"name":"João"}
      "
    `);
    await writeJsonFile(join(root, 'config.json'), { id: 1 });
    expect(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))).toEqual({ id: 1 });
  });

  it('rejects unsafe folder names, escaped paths and symlinks', async () => {
    const root = await folder();
    for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a..b'])
      expect(() => validateResumeName(name)).toThrow();
    expect(validateResumeName('account-data-2026')).toBe('account-data-2026');
    for (const name of ['', '..', '../x', '/outside'])
      expect(() => snapshotFile(root, name)).toThrow();
    await symlink(root, join(root, 'link'));
    await expect(safeDirectory(join(root, 'link'), false)).rejects.toThrow();
    await writeFile(join(root, 'regular'), 'x');
    await expect(safeDirectory(join(root, 'regular'), false)).rejects.toThrow();
    await expect(safeDirectory(join(root, 'missing'), false)).rejects.toThrow();
    await safeDirectory(join(root, 'new', 'nested'), true);
    await symlink(join(root, 'regular'), join(root, 'users.ndjson'));
    await expect(appendPage(root, 'users.ndjson', [{ id: 1 }])).rejects.toThrow();
    await expect(truncateFiles(root, { 'users.ndjson': { bytes: 0, lines: 0 } })).rejects.toThrow();
    expect(await readFile(join(root, 'regular'), 'utf8')).toBe('x');
  });

  it('rejects corrupt/missing checkpoints rather than extending data with zeros', async () => {
    const root = await folder();
    await appendPage(root, 'a.ndjson', []);
    await truncateFiles(root, { 'optional.ndjson': { bytes: 0, lines: 0 } });
    await expect(
      truncateFiles(root, { 'missing.ndjson': { bytes: 1, lines: 1 } }),
    ).rejects.toThrow();
    await expect(truncateFiles(root, { 'a.ndjson': { bytes: 1, lines: 1 } })).rejects.toThrow(
      /shorter/,
    );
    await expect(truncateFiles(root, { 'a.ndjson': { bytes: -1, lines: 0 } })).rejects.toThrow(
      /Invalid/,
    );
    await expect(truncateFiles(root, { 'a.ndjson': { bytes: 0, lines: 1.5 } })).rejects.toThrow(
      /Invalid/,
    );
  });
});
