import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDeps } from '../../../src/export/rate-limit';
import { createAdminTools } from '../../../src/tools/admin';
import { mswServer } from '../../setup';

const API = 'https://testsubdomain.zendesk.com/api/v2';
afterEach(() => vi.restoreAllMocks());

describe('export_data background job', () => {
  it('returns before the first page, shares one job across contexts, and reports durable progress', async () => {
    let time = Date.parse('2026-01-01T00:00:00Z');
    vi.spyOn(defaultDeps, 'now').mockImplementation(() => time);
    vi.spyOn(defaultDeps, 'sleep').mockImplementation(async (ms) => {
      time += ms;
    });
    const root = await mkdtemp(join(tmpdir(), 'tool-data-export-'));
    const ctx = { subdomain: 'testsubdomain', getToken: () => 'token', exportDir: root };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    mswServer.use(
      http.get(`${API}/groups`, async () => {
        requests += 1;
        await gate;
        return HttpResponse.json({ groups: [{ id: 1 }] });
      }),
    );
    const tool = createAdminTools(ctx).find((entry) => entry.name === 'export_data');
    if (!tool) throw new Error('Missing tool');
    const [first, second] = await Promise.all([
      tool.handler({ streams: ['groups'] }),
      tool.handler({ streams: ['users'] }),
    ]);
    const a = JSON.parse(String(first.content[0]?.['text']));
    const b = JSON.parse(String(second.content[0]?.['text']));
    expect(a.snapshot).toBe(b.snapshot);
    expect(a.running).toBe(true);
    expect(a.progress).toContain('manifest.json');
    expect(await readdir(root)).toHaveLength(1);
    const again = createAdminTools(ctx).find((entry) => entry.name === 'export_data');
    if (!again) throw new Error('Missing second tool');
    expect(JSON.parse(String((await again.handler({})).content[0]?.['text'])).snapshot).toBe(
      a.snapshot,
    );
    release?.();
    await vi.waitFor(
      async () => {
        const manifest = JSON.parse(await readFile(join(a.snapshot, 'manifest.json'), 'utf8'));
        expect(manifest.streams.groups.status).toBe('exported');
        expect(manifest.finished_at).toBeDefined();
      },
      { interval: 1 },
    );
    expect(requests).toBe(1);
  });

  it('releases failed preparations so a corrected call can start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tool-data-error-'));
    const tool = createAdminTools({
      subdomain: 'testsubdomain',
      exportDir: root,
      getToken: () => 'token',
    }).find((entry) => entry.name === 'export_data');
    if (!tool) throw new Error('Missing tool');
    await expect(tool.handler({ resume: '../escape' })).rejects.toThrow();
    await expect(tool.handler({ since: 'bad-date' })).rejects.toThrow();
    expect(await readdir(root)).toHaveLength(0);
  });
});

it('handles a rejected token in a background job without an unhandled rejection and releases the job', async () => {
  let time = Date.parse('2026-01-01T00:00:00Z');
  vi.spyOn(defaultDeps, 'now').mockImplementation(() => time);
  vi.spyOn(defaultDeps, 'sleep').mockImplementation(async (ms) => {
    time += ms;
  });
  const root = await mkdtemp(join(tmpdir(), 'tool-data-auth-'));
  const tool = createAdminTools({
    subdomain: 'testsubdomain',
    getToken: () => 'token',
    exportDir: root,
  }).find((entry) => entry.name === 'export_data');
  if (!tool) throw new Error('Missing tool');
  let me = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mswServer.use(
    http.get(`${API}/users/me`, () => {
      me += 1;
      return me === 1
        ? HttpResponse.json({ user: { id: 1, role: 'admin' } })
        : HttpResponse.json({}, { status: 401 });
    }),
    http.get(`${API}/groups`, async () => {
      await gate;
      return HttpResponse.json({}, { status: 401 });
    }),
  );
  const result = await tool.handler({ streams: ['groups'] });
  const job = JSON.parse(String(result.content[0]?.['text']));
  release?.();
  await vi.waitFor(
    async () => {
      const manifest = JSON.parse(await readFile(join(job.snapshot, 'manifest.json'), 'utf8'));
      expect(manifest.streams.groups.status).toBe('failed');
    },
    { interval: 1 },
  );
  await vi.waitFor(
    async () => {
      await expect(tool.handler({ since: 'invalid' })).rejects.toThrow();
    },
    { interval: 1 },
  );
});
