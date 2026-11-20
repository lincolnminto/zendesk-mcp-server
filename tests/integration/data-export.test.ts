import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { expect, it, vi } from 'vitest';
import { defaultDeps } from '../../src/export/rate-limit';
import { mswServer } from '../setup';
import { makeConfig } from './harness';
import { stdioHarness } from './stdio-harness';

it('exports data through the read-only admin proxy and returns the running job on polling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'data-mcp-'));
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
    http.get('https://testsubdomain.zendesk.com/api/v2/groups', async () => {
      await gate;
      return HttpResponse.json({ groups: [{ id: 1 }] });
    }),
  );
  const connected = await stdioHarness.connect(
    makeConfig({ mode: 'namespace', readOnly: true, exportDir: root }),
  );
  try {
    const listed = await connected.client.listTools();
    const admin = listed.tools.find((tool) => tool.name === 'zendesk_admin');
    expect(admin?.description).toContain('export_data');
    const result = await connected.client.callTool({
      name: 'zendesk_admin',
      arguments: { operation: 'export_data', params: { streams: ['groups'] } },
    });
    expect(result.isError).toBeFalsy();
    const initial = JSON.parse(String((result.content as Array<{ text: string }>)[0]?.text));
    expect(initial.running).toBe(true);
    const poll = await connected.client.callTool({
      name: 'zendesk_admin',
      arguments: { operation: 'export_data', params: {} },
    });
    const progress = JSON.parse(String((poll.content as Array<{ text: string }>)[0]?.text));
    expect(progress.snapshot).toBe(initial.snapshot);
    release?.();
    await vi.waitFor(
      async () => {
        const manifest = JSON.parse(
          await readFile(join(initial.snapshot, 'manifest.json'), 'utf8'),
        );
        expect(manifest.finished_at).toBeDefined();
        expect(manifest.streams.groups.files['groups.ndjson']).toEqual({ lines: 1, bytes: 9 });
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

it('selects custom records and incremental side conversations through the admin proxy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'additional-data-mcp-'));
  let time = Date.parse('2026-01-01T00:00:00Z');
  const now = vi.spyOn(defaultDeps, 'now').mockImplementation(() => time);
  const sleep = vi.spyOn(defaultDeps, 'sleep').mockImplementation(async (ms) => {
    time += ms;
  });
  const api = 'https://testsubdomain.zendesk.com/api/v2';
  mswServer.use(
    http.get(`${api}/custom_objects`, () =>
      HttpResponse.json({ custom_objects: [{ key: 'devices' }], meta: { has_more: false } }),
    ),
    http.get(`${api}/custom_objects/devices/records`, () =>
      HttpResponse.json({ custom_object_records: [{ id: 'r1' }], meta: { has_more: false } }),
    ),
    http.get(`${api}/tickets/side_conversations/events`, () =>
      HttpResponse.json({
        events: [{ id: 'e1', ticket_id: 8, side_conversation_id: 'sc1' }],
        count: 1,
        end_time: 5,
      }),
    ),
    http.get(`${api}/tickets/8/side_conversations/sc1`, () =>
      HttpResponse.json({ side_conversation: { id: 'sc1' } }),
    ),
  );
  const connected = await stdioHarness.connect(
    makeConfig({ mode: 'namespace', readOnly: true, exportDir: root }),
  );
  try {
    const result = await connected.client.callTool({
      name: 'zendesk_admin',
      arguments: {
        operation: 'export_data',
        params: { since: '3', streams: ['custom_object_records', 'side_conversation_events'] },
      },
    });
    expect(result.isError).toBeFalsy();
    const initial = JSON.parse(String((result.content as Array<{ text: string }>)[0]?.text));
    await vi.waitFor(
      async () => {
        const manifest = JSON.parse(
          await readFile(join(initial.snapshot, 'manifest.json'), 'utf8'),
        );
        expect(manifest.finished_at).toBeDefined();
        expect(manifest.streams.custom_object_records.status).toBe('exported');
        expect(manifest.streams.side_conversation_events.status).toBe('exported');
        expect(
          manifest.streams.custom_object_records.files['custom_object_records.ndjson'].lines,
        ).toBe(1);
        expect(
          manifest.streams.side_conversation_events.files['side_conversation_events.ndjson'].lines,
        ).toBe(1);
        expect(
          manifest.streams.side_conversation_events.files['side_conversations.ndjson'].lines,
        ).toBe(1);
      },
      { interval: 1 },
    );
  } finally {
    await connected.close();
    now.mockRestore();
    sleep.mockRestore();
  }
});
