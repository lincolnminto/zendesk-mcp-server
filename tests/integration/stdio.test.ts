import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MOCK_UPLOAD } from '../msw-handlers';
import { mswServer } from '../setup';
import { registerCoreScenarios } from './core-scenarios';
import { type ConnectedClient, makeConfig } from './harness';
import { stdioHarness } from './stdio-harness';

// Runs the shared MCP roundtrip scenarios against the stdio transport. When the
// HTTP transport lands, a sibling http.test.ts will call registerCoreScenarios
// with an http harness to get the same coverage for free.
registerCoreScenarios(stdioHarness);

// Not a core scenario: reading a caller-named path is stdio-only by design (over
// HTTP the path would resolve on the server host), so it cannot be shared.
describe('[stdio] attachment_paths', () => {
  let connected: ConnectedClient | undefined;
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zendesk-mcp-stdio-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    await connected?.close();
    connected = undefined;
  });

  it('reads a local file by absolute path and uploads it with the note', async () => {
    const filePath = join(dir, 'evidence.csv');
    await writeFile(filePath, 'id,status\n1,open\n');
    const uploads: Array<{ filename: string | null; contentType: string | null; body: string }> =
      [];
    mswServer.use(
      http.post('https://testsubdomain.zendesk.com/api/v2/uploads', async ({ request }) => {
        uploads.push({
          filename: new URL(request.url).searchParams.get('filename'),
          contentType: request.headers.get('content-type'),
          body: Buffer.from(await request.arrayBuffer()).toString('utf8'),
        });
        return HttpResponse.json({ upload: MOCK_UPLOAD });
      }),
    );

    connected = await stdioHarness.connect(makeConfig({ mode: 'all' }));
    const result = await connected.client.callTool({
      name: 'add_private_note',
      arguments: { ticket_id: 1, body: 'Export attached', attachment_paths: [filePath] },
    });

    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text?: string }>)[0]?.text).toBe(
      'Private note added to ticket #1 with 1 attachment(s).',
    );
    expect(uploads).toEqual([
      { filename: 'evidence.csv', contentType: 'text/csv', body: 'id,status\n1,open\n' },
    ]);
  });
});

// Not a core scenario either: the export writes files on the caller's machine,
// which only stdio can do (over HTTP they would land on the server host).
describe('[stdio] export_account_config', () => {
  let connected: ConnectedClient | undefined;
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zendesk-mcp-export-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    await connected?.close();
    connected = undefined;
  });

  it('lists no admin proxy unless the operator configured an export directory', async () => {
    connected = await stdioHarness.connect(makeConfig({ mode: 'namespace' }));
    const { tools } = await connected.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('zendesk_admin');
  });

  it.each(['all', 'namespace', 'single'] as const)(
    'lists API token metadata through a read-only server in %s mode',
    async (mode) => {
      const pages: Array<string | null> = [];
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/api_tokens', ({ request }) => {
          const page = new URL(request.url).searchParams.get('page');
          pages.push(page);
          return HttpResponse.json({
            api_tokens: [
              {
                id: page ? 2 : 1,
                description: 'Integration',
                active: true,
                created_at: '2026-01-01T00:00:00Z',
                updated_at: null,
                last_used: page ? null : '2026-11-01T00:00:00Z',
                token: 'synthetic-secret',
                visible_token: 'synthetic-prefix',
              },
            ],
            next_page: page ? null : 'https://testsubdomain.zendesk.com/api/v2/api_tokens?page=2',
          });
        }),
      );

      connected = await stdioHarness.connect(makeConfig({ mode, readOnly: true, exportDir: dir }));
      const { tools } = await connected.client.listTools();
      const name = {
        all: 'list_api_tokens',
        namespace: 'zendesk_admin',
        single: 'zendesk',
      }[mode];
      expect(tools.find((tool) => tool.name === name)?.description).toContain('last usage time');
      if (mode === 'all') {
        expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
      }
      const result = await connected.client.callTool({
        name,
        arguments: mode === 'all' ? {} : { operation: 'list_api_tokens', params: {} },
      });

      expect(result.isError).toBeFalsy();
      expect(pages).toEqual([null, '2']);
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(JSON.parse(text)).toMatchInlineSnapshot(`
        {
          "api_tokens": [
            {
              "active": true,
              "created_at": "2026-01-01T00:00:00Z",
              "description": "Integration",
              "id": 1,
              "last_used": "2026-11-01T00:00:00Z",
              "updated_at": null,
            },
            {
              "active": true,
              "created_at": "2026-01-01T00:00:00Z",
              "description": "Integration",
              "id": 2,
              "last_used": null,
              "updated_at": null,
            },
          ],
        }
      `);
    },
  );

  it('exports through the admin proxy of a read-only server and writes the snapshot locally', async () => {
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/triggers', () =>
        HttpResponse.json({ triggers: [{ id: 1, title: 'Notify requester' }], next_page: null }),
      ),
    );

    connected = await stdioHarness.connect(
      makeConfig({ mode: 'namespace', readOnly: true, exportDir: dir }),
    );
    const { tools } = await connected.client.listTools();
    expect(tools.map((t) => t.name)).toContain('zendesk_admin');

    const result = await connected.client.callTool({
      name: 'zendesk_admin',
      arguments: {
        operation: 'export_account_config',
        params: { resources: ['triggers'] },
      },
    });

    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text?: string }>)[0]?.text).toContain(
      '1 exported, 0 skipped, 0 failed.',
    );
    const [snapshot] = await readdir(dir);
    expect(JSON.parse(await readFile(join(dir, snapshot ?? '', 'triggers.json'), 'utf8'))).toEqual([
      { id: 1, title: 'Notify requester' },
    ]);
  });
});
