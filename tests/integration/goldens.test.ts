import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { expect, it, vi } from 'vitest';
import { defaultDeps } from '../../src/export/rate-limit';
import { mswServer } from '../setup';
import { makeConfig } from './harness';
import { stdioHarness } from './stdio-harness';

it('records goldens through the read-only admin proxy and polls the same background job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goldens-mcp-'));
  await mkdir(join(root, 'data'));
  let time = Date.parse('2026-01-01T00:00:00Z');
  const now = vi.spyOn(defaultDeps, 'now').mockImplementation(() => time);
  const sleep = vi.spyOn(defaultDeps, 'sleep').mockImplementation(async (ms) => {
    time += ms;
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mswServer.use(
    http.get('https://testsubdomain.zendesk.com/api/v2/users/:id/group_memberships', async () => {
      await gate;
      return HttpResponse.json({ group_memberships: [] });
    }),
  );
  const connected = await stdioHarness.connect(
    makeConfig({ mode: 'namespace', readOnly: true, exportDir: root }),
  );
  try {
    const listed = await connected.client.listTools();
    expect(listed.tools.find((t) => t.name === 'zendesk_admin')?.description).toContain(
      'record_goldens',
    );
    const call = () =>
      connected.client.callTool({
        name: 'zendesk_admin',
        arguments: {
          operation: 'record_goldens',
          params: { data_snapshot: 'data', stages: ['context'] },
        },
      });
    const first = await call();
    expect(first.isError).toBeFalsy();
    const job = JSON.parse(String((first.content as Array<{ text: string }>)[0]?.text));
    expect(job.running).toBe(true);
    const second = await call();
    expect(JSON.parse(String((second.content as Array<{ text: string }>)[0]?.text)).snapshot).toBe(
      job.snapshot,
    );
    const dataPoll = await connected.client.callTool({
      name: 'zendesk_admin',
      arguments: { operation: 'export_data', params: {} },
    });
    expect(
      JSON.parse(String((dataPoll.content as Array<{ text: string }>)[0]?.text)).snapshot,
    ).toBe(job.snapshot);
    release?.();
    await vi.waitFor(
      async () => {
        const manifest = JSON.parse(await readFile(join(job.snapshot, 'manifest.json'), 'utf8'));
        expect(manifest.finished_at).toBeDefined();
        expect(manifest.stages.context.status).toBe('done');
      },
      { interval: 1 },
    );
  } finally {
    release?.();
    await connected.close();
    now.mockRestore();
    sleep.mockRestore();
  }
});
