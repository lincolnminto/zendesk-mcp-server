import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_RESOURCES,
  RESOURCE_KEYS,
  runConfigExport,
} from '../../../src/export/account-config';
import { runDataExport } from '../../../src/export/data-export';
import { createAdminTools } from '../../../src/tools/admin';
import type { ToolContext } from '../../../src/tools/definitions';
import { mswServer } from '../../setup';

const API = 'https://testsubdomain.zendesk.com/api/v2';

// Documented shape of GET /api/v2/ticket_form_statuses: a ULID string id and the
// numeric ids of the form and the custom status it offers. Fictional ids.
const STATUSES = [
  { id: '01JTESTFORMSTATUS000000001', ticket_form_id: 1001, custom_status_id: 2001 },
  { id: '01JTESTFORMSTATUS000000002', ticket_form_id: 1001, custom_status_id: 2002 },
  { id: '01JTESTFORMSTATUS000000003', ticket_form_id: 1002, custom_status_id: 2001 },
];

const ctx = (): ToolContext => ({ subdomain: 'testsubdomain', getToken: () => 'test-token' });

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

let snapshot: string;

beforeEach(async () => {
  snapshot = await mkdtemp(join(tmpdir(), 'zmcp-form-statuses-'));
});

afterEach(async () => {
  await rm(snapshot, { recursive: true, force: true });
});

describe('ticket_form_statuses in the account configuration export', () => {
  it('is catalogued right after custom_statuses, read from /ticket_form_statuses', () => {
    expect(RESOURCE_KEYS.indexOf('ticket_form_statuses')).toBe(
      RESOURCE_KEYS.indexOf('custom_statuses') + 1,
    );
    expect(CONFIG_RESOURCES.ticket_form_statuses).toEqual({
      path: '/ticket_form_statuses',
      responseKey: 'ticket_form_statuses',
    });
  });

  it('writes the raw associations to ticket_form_statuses.json and lists them in the manifest', async () => {
    const queries: string[] = [];
    mswServer.use(
      http.get(`${API}/ticket_form_statuses`, ({ request }) => {
        queries.push(new URL(request.url).search);
        return HttpResponse.json({ ticket_form_statuses: STATUSES });
      }),
    );

    const entries = await runConfigExport(
      ctx(),
      snapshot,
      ['ticket_form_statuses'],
      undefined,
      new Date('2026-01-01T00:00:00Z'),
    );

    expect(entries).toEqual([
      {
        resource: 'ticket_form_statuses',
        endpoint: '/api/v2/ticket_form_statuses',
        status: 'exported',
        items: 3,
        file: 'ticket_form_statuses.json',
        truncated: false,
      },
    ]);
    expect(queries).toEqual(['?page%5Bsize%5D=100']);
    expect(await readJson(join(snapshot, 'ticket_form_statuses.json'))).toEqual(STATUSES);
    expect(await readJson(join(snapshot, 'manifest.json'))).toEqual({
      subdomain: 'testsubdomain',
      exported_at: '2026-01-01T00:00:00.000Z',
      resources: entries,
    });
    expect((await readdir(snapshot)).sort()).toEqual([
      'manifest.json',
      'ticket_form_statuses.json',
    ]);
  });

  it('reads the list unpaged when the endpoint refuses page[size]', async () => {
    const queries: string[] = [];
    mswServer.use(
      http.get(`${API}/ticket_form_statuses`, ({ request }) => {
        const url = new URL(request.url);
        queries.push(url.search);
        return url.searchParams.has('page[size]')
          ? HttpResponse.json({ error: 'InvalidPaginationParameter' }, { status: 400 })
          : HttpResponse.json({ ticket_form_statuses: STATUSES });
      }),
    );

    const [entry] = await runConfigExport(ctx(), snapshot, ['ticket_form_statuses']);

    expect(entry).toMatchObject({ status: 'exported', items: 3, truncated: false });
    expect(queries).toEqual(['?page%5Bsize%5D=100', '']);
    expect(await readJson(join(snapshot, 'ticket_form_statuses.json'))).toEqual(STATUSES);
  });

  it('follows cursor pages should the endpoint page its answer', async () => {
    mswServer.use(
      http.get(`${API}/ticket_form_statuses`, ({ request }) =>
        new URL(request.url).searchParams.get('page[after]') === 'c1'
          ? HttpResponse.json({
              ticket_form_statuses: STATUSES.slice(2),
              meta: { has_more: false, after_cursor: null },
              links: { next: null },
            })
          : HttpResponse.json({
              ticket_form_statuses: STATUSES.slice(0, 2),
              meta: { has_more: true, after_cursor: 'c1' },
              links: { next: `${API}/ticket_form_statuses?page%5Bafter%5D=c1&page%5Bsize%5D=100` },
            }),
      ),
    );

    const [entry] = await runConfigExport(ctx(), snapshot, ['ticket_form_statuses']);

    expect(entry).toMatchObject({ status: 'exported', items: 3, truncated: false });
    expect(await readJson(join(snapshot, 'ticket_form_statuses.json'))).toEqual(STATUSES);
  });

  it('follows offset pages through next_page', async () => {
    mswServer.use(
      http.get(`${API}/ticket_form_statuses`, ({ request }) =>
        new URL(request.url).searchParams.get('page') === '2'
          ? HttpResponse.json({ ticket_form_statuses: STATUSES.slice(1), next_page: null })
          : HttpResponse.json({
              ticket_form_statuses: STATUSES.slice(0, 1),
              next_page: `${API}/ticket_form_statuses?page=2`,
            }),
      ),
    );

    const [entry] = await runConfigExport(ctx(), snapshot, ['ticket_form_statuses']);

    expect(entry).toMatchObject({ status: 'exported', items: 3 });
    expect(await readJson(join(snapshot, 'ticket_form_statuses.json'))).toEqual(STATUSES);
  });

  it.each([
    [
      403,
      'Forbidden',
      'No access (403 Forbidden): the signed-in account cannot read it, or the plan lacks it.',
    ],
    [
      404,
      'InvalidEndpoint',
      'Not available on this account (404 InvalidEndpoint): the feature is off or not on this plan, or the endpoint does not exist.',
    ],
  ])('skips the resource on a %i and keeps exporting the rest', async (status, error, reason) => {
    mswServer.use(
      http.get(`${API}/ticket_form_statuses`, () => HttpResponse.json({ error }, { status })),
      http.get(`${API}/custom_statuses`, () =>
        HttpResponse.json({ custom_statuses: [{ id: 2001 }] }),
      ),
    );

    const entries = await runConfigExport(ctx(), snapshot, [
      'custom_statuses',
      'ticket_form_statuses',
    ]);

    expect(entries).toEqual([
      expect.objectContaining({ resource: 'custom_statuses', status: 'exported', items: 1 }),
      {
        resource: 'ticket_form_statuses',
        endpoint: '/api/v2/ticket_form_statuses',
        status: 'skipped',
        reason,
      },
    ]);
    expect((await readdir(snapshot)).sort()).toEqual(['custom_statuses.json', 'manifest.json']);
  });

  it('records a failure without aborting the export', async () => {
    mswServer.use(
      http.get(`${API}/ticket_form_statuses`, () =>
        HttpResponse.json({ ticket_form_statuses: { id: 'not-a-list' } }),
      ),
    );

    const [entry] = await runConfigExport(ctx(), snapshot, ['ticket_form_statuses']);

    expect(entry).toEqual({
      resource: 'ticket_form_statuses',
      endpoint: '/api/v2/ticket_form_statuses',
      status: 'failed',
      reason: 'Unexpected response shape: "ticket_form_statuses" is not a list',
    });
  });

  it('is selectable by name in export_account_config', async () => {
    mswServer.use(
      http.get(`${API}/ticket_form_statuses`, () =>
        HttpResponse.json({ ticket_form_statuses: STATUSES }),
      ),
    );
    const tool = createAdminTools({ ...ctx(), exportDir: snapshot }).find(
      (t) => t.name === 'export_account_config',
    );
    if (!tool) throw new Error('export_account_config not found');

    expect(tool.inputSchema.safeParse({ resources: ['ticket_form_statuses'] }).success).toBe(true);
    const result = await tool.handler({ resources: ['ticket_form_statuses'] });

    expect(result.content[0]?.text).toContain('| ticket_form_statuses | exported | 3 |');
  });

  it('lands in config/ticket_form_statuses.json of a data snapshot', async () => {
    mswServer.use(
      http.get(`${API}/*`, ({ request }) => {
        const path = new URL(request.url).pathname.slice('/api/v2'.length);
        if (path === '/users/me') return HttpResponse.json({ user: { id: 1, role: 'admin' } });
        if (path === '/ticket_form_statuses')
          return HttpResponse.json({ ticket_form_statuses: STATUSES });
        return HttpResponse.json({}, { status: 404 });
      }),
    );

    const result = await runDataExport({
      subdomain: 'testsubdomain',
      getToken: () => 'token',
      exportDir: snapshot,
      streams: ['config'],
      deps: { now: () => 0, sleep: async () => {} },
    });

    expect(result.manifest.streams.config?.status).toBe('exported');
    expect(result.manifest.streams.config?.files['config/ticket_form_statuses.json']).toBeDefined();
    expect(await readJson(join(result.snapshot, 'config/ticket_form_statuses.json'))).toEqual(
      STATUSES,
    );
    const config = (await readJson(join(result.snapshot, 'config/manifest.json'))) as {
      resources: Array<{ resource: string; status: string; items?: number }>;
    };
    expect(config.resources.find((r) => r.resource === 'ticket_form_statuses')).toMatchObject({
      status: 'exported',
      items: 3,
    });
  });
});
