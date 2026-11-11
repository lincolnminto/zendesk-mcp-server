import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_RESOURCES,
  createAdminTools,
  extractItems,
  MAX_PAGES,
  nextRequest,
  snapshotDirName,
} from '../../../src/tools/admin';
import type { ToolContext } from '../../../src/tools/definitions';
import { mswServer } from '../../setup';

const API = 'https://testsubdomain.zendesk.com/api/v2';
// Built per test: the export directory is the fresh temp folder of that test.
const exportCtx = (): ToolContext => ({
  subdomain: 'testsubdomain',
  getToken: () => 'test-token',
  exportDir: root,
});

const exportTool = (ctx: ToolContext = exportCtx()) => {
  const tool = createAdminTools(ctx).find((t) => t.name === 'export_account_config');
  if (!tool) throw new Error('export_account_config not found');
  return tool;
};

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content[0]?.text ?? '';

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

let root: string;

// The one snapshot folder an export created under `root`.
const snapshotOf = async (dir: string): Promise<string> => {
  const entries = await readdir(dir);
  if (entries.length !== 1)
    throw new Error(`expected one snapshot folder, found ${entries.length}`);
  return join(dir, entries[0] ?? '');
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zmcp-export-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('admin tools', () => {
  it('registers the export: Zendesk-read-only, but honest that it writes local files', () => {
    const tools = createAdminTools(exportCtx());
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'export_account_config',
      namespace: 'admin',
      readOnly: true,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
  });

  it('registers nothing without an operator-configured export directory', () => {
    expect(createAdminTools({ subdomain: 'testsubdomain', getToken: () => 'test-token' })).toEqual(
      [],
    );
  });
});

describe('export_account_config', () => {
  it('writes each resource to its own file in a new snapshot folder, with a manifest and a summary', async () => {
    mswServer.use(
      http.get(`${API}/triggers`, () =>
        HttpResponse.json({ triggers: [{ id: 1, title: 'Notify requester' }], next_page: null }),
      ),
      http.get(`${API}/account/settings`, () =>
        HttpResponse.json({ settings: { tickets: { comments_public_by_default: true } } }),
      ),
      http.get(`${API}/group_slas/policies`, () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
      ),
    );

    const result = await exportTool().handler({
      resources: ['triggers', 'account_settings', 'group_sla_policies'],
    });

    const snapshot = await snapshotOf(root);
    expect(snapshot).toMatch(/testsubdomain-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
    expect((await readdir(snapshot)).sort()).toEqual([
      'account_settings.json',
      'manifest.json',
      'triggers.json',
    ]);
    expect(await readJson(join(snapshot, 'triggers.json'))).toEqual([
      { id: 1, title: 'Notify requester' },
    ]);
    expect(await readJson(join(snapshot, 'account_settings.json'))).toEqual({
      tickets: { comments_public_by_default: true },
    });

    const manifest = (await readJson(join(snapshot, 'manifest.json'))) as {
      subdomain: string;
      exported_at: string;
      resources: unknown[];
    };
    expect(manifest.subdomain).toBe('testsubdomain');
    expect(Number.isNaN(Date.parse(manifest.exported_at))).toBe(false);
    expect(manifest.resources).toEqual([
      {
        resource: 'account_settings',
        endpoint: '/api/v2/account/settings',
        status: 'exported',
        items: 1,
        file: 'account_settings.json',
        truncated: false,
      },
      {
        resource: 'triggers',
        endpoint: '/api/v2/triggers',
        status: 'exported',
        items: 1,
        file: 'triggers.json',
        truncated: false,
      },
      {
        resource: 'group_sla_policies',
        endpoint: '/api/v2/group_slas/policies',
        status: 'skipped',
        reason:
          'No access (403 Forbidden): the signed-in account cannot read it, or the plan lacks it.',
      },
    ]);

    expect(textOf(result).replace(snapshot, '<snapshot>')).toMatchInlineSnapshot(`
      "Exported the testsubdomain account configuration to <snapshot>
      2 exported, 1 skipped, 0 failed. manifest.json has the per-resource details; each <resource>.json holds the raw Zendesk objects.

      | Resource | Status | Items |
      |---|---|---|
      | account_settings | exported | 1 |
      | triggers | exported | 1 |
      | group_sla_policies | skipped: No access (403 Forbidden): the signed-in account cannot read it, or the plan lacks it. | - |"
    `);
  });

  it('exports the whole catalog when no resources are named', async () => {
    let requests = 0;
    mswServer.use(
      http.get(`${API}/*`, ({ request }) => {
        requests += 1;
        const path = new URL(request.url).pathname.replace('/api/v2', '');
        const spec = Object.values(CONFIG_RESOURCES).find((r) => r.path === path);
        if (!spec) return HttpResponse.json({ error: 'unexpected' }, { status: 400 });
        return HttpResponse.json({ [spec.responseKey]: 'single' in spec ? {} : [] });
      }),
    );

    const result = await exportTool().handler({});

    const keys = Object.keys(CONFIG_RESOURCES);
    expect(requests).toBe(keys.length);
    const snapshot = await snapshotOf(root);
    const manifest = (await readJson(join(snapshot, 'manifest.json'))) as {
      resources: Array<{ resource: string; status: string }>;
    };
    expect(manifest.resources.map((r) => r.resource)).toEqual(keys);
    expect(manifest.resources.every((r) => r.status === 'exported')).toBe(true);
    expect((await readdir(snapshot)).sort()).toEqual(
      [...keys.map((k) => `${k}.json`), 'manifest.json'].sort(),
    );
    expect(textOf(result)).toContain(`${keys.length} exported, 0 skipped, 0 failed.`);
  });

  it('follows offset pagination through next_page', async () => {
    mswServer.use(
      http.get(`${API}/macros`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page');
        return page === '2'
          ? HttpResponse.json({ macros: [{ id: 2 }], next_page: null })
          : HttpResponse.json({
              macros: [{ id: 1 }],
              next_page: `${API}/macros.json?page=2&per_page=100`,
            });
      }),
      http.get(`${API}/macros.json`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page');
        return HttpResponse.json(
          page === '2' ? { macros: [{ id: 2 }], next_page: null } : { error: 'bad page' },
          { status: page === '2' ? 200 : 400 },
        );
      }),
    );

    await exportTool().handler({ resources: ['macros'] });

    const snapshot = await snapshotOf(root);
    expect(await readJson(join(snapshot, 'macros.json'))).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('follows cursor pagination through links.next while has_more', async () => {
    mswServer.use(
      http.get(`${API}/webhooks`, ({ request }) => {
        const after = new URL(request.url).searchParams.get('page[after]');
        return after === 'c1'
          ? HttpResponse.json({
              webhooks: [{ id: 'w2' }],
              meta: { has_more: false },
              links: { next: null },
            })
          : HttpResponse.json({
              webhooks: [{ id: 'w1' }],
              meta: { has_more: true, after_cursor: 'c1' },
              links: { next: `${API}/webhooks?page%5Bafter%5D=c1&page%5Bsize%5D=20` },
            });
      }),
    );

    await exportTool().handler({ resources: ['webhooks'] });

    const snapshot = await snapshotOf(root);
    expect(await readJson(join(snapshot, 'webhooks.json'))).toEqual([{ id: 'w1' }, { id: 'w2' }]);
  });

  it('stops at the page guard and flags the resource as truncated', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${API}/views`, () => {
        calls += 1;
        return HttpResponse.json({
          views: [{ id: calls }],
          next_page: `${API}/views?page=${calls + 1}`,
        });
      }),
    );

    const result = await exportTool().handler({ resources: ['views'] });

    expect(calls).toBe(MAX_PAGES);
    const snapshot = await snapshotOf(root);
    const manifest = (await readJson(join(snapshot, 'manifest.json'))) as {
      resources: Array<{ items: number; truncated: boolean }>;
    };
    expect(manifest.resources[0]).toMatchObject({ items: MAX_PAGES, truncated: true });
    expect(textOf(result)).toContain(`| views | exported (truncated) | ${MAX_PAGES} |`);
  });

  it('records a pagination link that leaves this account as a failure, without following it', async () => {
    let foreignCalls = 0;
    mswServer.use(
      http.get(`${API}/triggers`, () =>
        HttpResponse.json({
          triggers: [{ id: 1 }],
          next_page: 'https://attacker.example.com/api/v2/triggers?page=2',
        }),
      ),
      http.get('https://attacker.example.com/*', () => {
        foreignCalls += 1;
        return HttpResponse.json({ triggers: [] });
      }),
    );

    const result = await exportTool().handler({ resources: ['triggers'] });

    expect(foreignCalls).toBe(0);
    const snapshot = await snapshotOf(root);
    expect(await readdir(snapshot)).toEqual(['manifest.json']);
    expect(textOf(result)).toContain('0 exported, 0 skipped, 1 failed.');
    expect(textOf(result)).toContain(
      '| triggers | failed: Refusing to follow a pagination link outside this account API: https://attacker.example.com/api/v2/triggers | - |',
    );
  });

  it("skips a resource that is not available on the account (404), naming Zendesk's error code", async () => {
    mswServer.use(
      http.get(`${API}/custom_objects`, () =>
        HttpResponse.json({ error: 'InvalidEndpoint' }, { status: 404 }),
      ),
      http.get(`${API}/brands`, () => HttpResponse.json({ brands: [{ id: 7 }] })),
    );

    const result = await exportTool().handler({ resources: ['custom_objects', 'brands'] });

    expect(textOf(result)).toContain('1 exported, 1 skipped, 0 failed.');
    expect(textOf(result)).toContain(
      '| custom_objects | skipped: Not available on this account (404 InvalidEndpoint): the feature is off or not on this plan, or the endpoint does not exist. | - |',
    );
  });

  it('records any other API error as a failure and keeps going', async () => {
    mswServer.use(
      http.get(`${API}/targets`, () => HttpResponse.json({ error: 'Bad' }, { status: 400 })),
      http.get(`${API}/brands`, () => HttpResponse.json({ brands: [] })),
    );

    const result = await exportTool().handler({ resources: ['targets', 'brands'] });

    expect(textOf(result)).toContain('1 exported, 0 skipped, 1 failed.');
    expect(textOf(result)).toContain('| targets | failed: Zendesk API error 400');
  });

  it('records a 401 on one endpoint as a failure when the token still works, and keeps going', async () => {
    mswServer.use(
      http.get(`${API}/webhooks`, () => new HttpResponse(null, { status: 401 })),
      http.get(`${API}/users/me`, () => HttpResponse.json({ user: { id: 1 } })),
      http.get(`${API}/brands`, () => HttpResponse.json({ brands: [{ id: 7 }] })),
    );

    const result = await exportTool().handler({ resources: ['brands', 'webhooks'] });

    expect(textOf(result)).toContain('1 exported, 0 skipped, 1 failed.');
    expect(textOf(result)).toContain(
      '| webhooks | failed: Unauthorized (401) on this endpoint, while /users/me does not reject the token. | - |',
    );
  });

  it('lets a 401 propagate when the token itself is rejected, leaving a manifest of what was done', async () => {
    mswServer.use(
      http.get(`${API}/brands`, () => HttpResponse.json({ brands: [{ id: 7 }] })),
      http.get(`${API}/triggers`, () => new HttpResponse(null, { status: 401 })),
      http.get(`${API}/users/me`, () => new HttpResponse(null, { status: 401 })),
    );

    await expect(exportTool().handler({ resources: ['brands', 'triggers'] })).rejects.toMatchObject(
      { name: 'ZendeskApiError', status: 401 },
    );

    const snapshot = await snapshotOf(root);
    const manifest = (await readJson(join(snapshot, 'manifest.json'))) as {
      aborted: string;
      resources: Array<{ resource: string; status: string }>;
    };
    expect(manifest.aborted).toMatch(/^Authentication failed/);
    expect(manifest.resources).toEqual([
      expect.objectContaining({ resource: 'brands', status: 'exported' }),
    ]);
  });

  it('lets an authentication-required error from getToken propagate', async () => {
    const signIn = Object.assign(new Error('Zendesk authentication required.'), {
      name: 'AuthRequiredError',
    });
    const tool = exportTool({
      ...exportCtx(),
      getToken: () => {
        throw signIn;
      },
    });

    await expect(tool.handler({ resources: ['triggers'] })).rejects.toBe(signIn);
    expect(await readdir(root)).toEqual([]);
  });

  it('creates a missing target directory', async () => {
    mswServer.use(http.get(`${API}/groups`, () => HttpResponse.json({ groups: [] })));
    const nested = join(root, 'exports', 'zendesk');

    await exportTool({ ...exportCtx(), exportDir: nested }).handler({ resources: ['groups'] });

    const snapshot = await snapshotOf(nested);
    expect(await readJson(join(snapshot, 'groups.json'))).toEqual([]);
  });

  it('asks for cursor pagination first, falling back to offset when the endpoint refuses it', async () => {
    const seen: Array<string | null> = [];
    mswServer.use(
      http.get(`${API}/targets`, ({ request }) => {
        const size = new URL(request.url).searchParams.get('page[size]');
        seen.push(size);
        return size === null
          ? HttpResponse.json({ targets: [{ id: 3 }], next_page: null })
          : HttpResponse.json({ error: 'InvalidPaginationParameter' }, { status: 400 });
      }),
      http.get(`${API}/groups`, ({ request }) => {
        seen.push(new URL(request.url).searchParams.get('page[size]'));
        return HttpResponse.json({ groups: [{ id: 4 }], meta: { has_more: false } });
      }),
    );

    await exportTool().handler({ resources: ['groups', 'targets'] });

    expect(seen).toEqual(['100', '100', null]);
    const snapshot = await snapshotOf(root);
    expect(await readJson(join(snapshot, 'groups.json'))).toEqual([{ id: 4 }]);
    expect(await readJson(join(snapshot, 'targets.json'))).toEqual([{ id: 3 }]);
  });

  it('attaches nested lists to their parents (schedule holidays, custom object fields)', async () => {
    mswServer.use(
      http.get(`${API}/business_hours/schedules`, () =>
        HttpResponse.json({ schedules: [{ id: 11, name: 'BR' }, { name: 'no id' }] }),
      ),
      http.get(`${API}/business_hours/schedules/11/holidays`, () =>
        HttpResponse.json({ holidays: [{ id: 1, name: 'Natal' }] }),
      ),
      http.get(`${API}/custom_objects`, () =>
        HttpResponse.json({ custom_objects: [{ key: 'car', title: 'Car' }] }),
      ),
      http.get(`${API}/custom_objects/car/fields`, () =>
        HttpResponse.json({ custom_object_fields: [{ key: 'plate' }] }),
      ),
      http.get(`${API}/routing/attributes`, () =>
        HttpResponse.json({ attributes: [{ id: 'a1', name: 'Language' }] }),
      ),
      http.get(`${API}/routing/attributes/a1/values`, () =>
        HttpResponse.json({ attribute_values: [{ id: 'v1', name: 'pt-BR' }] }),
      ),
    );

    await exportTool().handler({
      resources: ['schedules', 'routing_attributes', 'custom_objects'],
    });

    const snapshot = await snapshotOf(root);
    expect(await readJson(join(snapshot, 'schedules.json'))).toEqual([
      { id: 11, name: 'BR', holidays: [{ id: 1, name: 'Natal' }] },
      { name: 'no id' },
    ]);
    expect(await readJson(join(snapshot, 'custom_objects.json'))).toEqual([
      { key: 'car', title: 'Car', fields: [{ key: 'plate' }] },
    ]);
    expect(await readJson(join(snapshot, 'routing_attributes.json'))).toEqual([
      { id: 'a1', name: 'Language', values: [{ id: 'v1', name: 'pt-BR' }] },
    ]);
  });

  it('keeps a parent whose nested list fails, and counts it', async () => {
    mswServer.use(
      http.get(`${API}/business_hours/schedules`, () =>
        HttpResponse.json({ schedules: [{ id: 11 }, { id: 12 }] }),
      ),
      http.get(`${API}/business_hours/schedules/11/holidays`, () =>
        HttpResponse.json({ holidays: [] }),
      ),
      http.get(`${API}/business_hours/schedules/12/holidays`, () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
      ),
    );

    const result = await exportTool().handler({ resources: ['schedules'] });

    expect(textOf(result)).toContain('| schedules | exported (1 nested lists missing) | 2 |');
    const snapshot = await snapshotOf(root);
    expect(await readJson(join(snapshot, 'schedules.json'))).toEqual([
      { id: 11, holidays: [] },
      { id: 12 },
    ]);
    const manifest = (await readJson(join(snapshot, 'manifest.json'))) as {
      resources: Record<string, unknown>[];
    };
    expect(manifest.resources[0]).toMatchObject({
      nested_missing: 1,
      nested_missing_reason:
        'holidays of id 12: Permission denied. Your Zendesk account does not have access to this resource.',
    });
  });

  it('records a list resource whose documented key holds no list as failed', async () => {
    mswServer.use(http.get(`${API}/views`, () => HttpResponse.json({ views: { id: 1 } })));

    const result = await exportTool().handler({ resources: ['views'] });

    expect(textOf(result)).toContain(
      '| views | failed: Unexpected response shape: "views" is not a list | - |',
    );
  });

  it('words a 404 without a JSON error code plainly', async () => {
    mswServer.use(
      http.get(`${API}/targets`, () => new HttpResponse('<html>Not here</html>', { status: 404 })),
    );

    const result = await exportTool().handler({ resources: ['targets'] });

    expect(textOf(result)).toContain(
      '| targets | skipped: Not available on this account (404): the feature is off or not on this plan, or the endpoint does not exist. | - |',
    );
  });

  it('never writes into an existing snapshot folder', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let groups = [{ id: 1 }];
      mswServer.use(http.get(`${API}/groups`, () => HttpResponse.json({ groups })));

      vi.setSystemTime(new Date('2026-11-11T17:30:05.123Z'));
      await exportTool().handler({ resources: ['groups'] });
      const first = join(root, 'testsubdomain-2026-11-11T17-30-05-123Z');
      const before = await readFile(join(first, 'groups.json'), 'utf8');

      // Same instant: the folder name collides, and the export must refuse rather
      // than write into the earlier snapshot.
      groups = [{ id: 2 }];
      await expect(exportTool().handler({ resources: ['groups'] })).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await readFile(join(first, 'groups.json'), 'utf8')).toBe(before);

      vi.setSystemTime(new Date('2026-11-11T17:31:00.000Z'));
      await exportTool().handler({ resources: ['groups'] });
      expect((await readdir(root)).sort()).toEqual([
        'testsubdomain-2026-11-11T17-30-05-123Z',
        'testsubdomain-2026-11-11T17-31-00-000Z',
      ]);
      expect(await readFile(join(first, 'groups.json'), 'utf8')).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a raw error body to one short table cell, and the full reason in the manifest', async () => {
    const body = `<html>\n<body>Bad | gateway ${'x'.repeat(300)}</body>\n</html>`;
    mswServer.use(http.get(`${API}/targets`, () => new HttpResponse(body, { status: 418 })));

    const result = await exportTool().handler({ resources: ['targets'] });

    const row =
      textOf(result)
        .split('\n')
        .find((line) => line.startsWith('| targets |')) ?? '';
    expect(row).not.toContain('<body>Bad |');
    expect(row).toContain('<body>Bad / gateway');
    expect(row).toMatch(/… \| - \|$/);
    const snapshot = await snapshotOf(root);
    const manifest = (await readJson(join(snapshot, 'manifest.json'))) as {
      resources: Array<{ reason: string }>;
    };
    expect(manifest.resources[0]?.reason).toContain(body);
  });
});

describe('nextRequest', () => {
  it('returns nothing on the last page', () => {
    expect(nextRequest({ triggers: [], next_page: null }, 'acme')).toBeUndefined();
    expect(
      nextRequest({ meta: { has_more: false }, links: { next: `${API}/x` } }, 'acme'),
    ).toBeUndefined();
  });

  it('turns an offset next_page into a path and params on this account', () => {
    expect(
      nextRequest(
        { next_page: 'https://acme.zendesk.com/api/v2/macros.json?page=2&per_page=100' },
        'acme',
      ),
    ).toEqual({ path: '/macros.json', params: { page: '2', per_page: '100' } });
  });

  it('prefers the cursor link while has_more', () => {
    expect(
      nextRequest(
        {
          meta: { has_more: true },
          links: { next: 'https://acme.zendesk.com/api/v2/webhooks?page%5Bafter%5D=c1' },
          next_page: 'https://acme.zendesk.com/api/v2/webhooks?page=9',
        },
        'acme',
      ),
    ).toEqual({ path: '/webhooks', params: { 'page[after]': 'c1' } });
  });

  it.each([
    ['another host', 'https://attacker.example.com/api/v2/macros?page=2'],
    ['another tenant', 'https://other.zendesk.com/api/v2/macros?page=2'],
    ['plain http', 'http://acme.zendesk.com/api/v2/macros?page=2'],
    ['a path outside the API', 'https://acme.zendesk.com/oauth/tokens?page=2'],
    ['a path that only starts like the API', 'https://acme.zendesk.com/api/v2evil/macros'],
  ])('refuses a link to %s', (_label, link) => {
    expect(() => nextRequest({ next_page: link }, 'acme')).toThrow(
      'Refusing to follow a pagination link outside this account API',
    );
  });
});

describe('extractItems', () => {
  it('reads the documented response key', () => {
    expect(extractItems({ triggers: [{ id: 1 }], count: 1 }, 'triggers')).toEqual([{ id: 1 }]);
  });

  it('falls back to the only list in a response whose key differs', () => {
    expect(extractItems({ rules: [{ id: 1 }], next_page: null, count: 1 }, 'triggers')).toEqual([
      { id: 1 },
    ]);
  });

  it('rejects a response with no recognizable list', () => {
    expect(() => extractItems({ a: [1], b: [2] }, 'triggers')).toThrow(
      'Unexpected response shape: no "triggers" list (keys: a, b)',
    );
    expect(() => extractItems({ meta: {}, links: {} }, 'triggers')).toThrow(
      'Unexpected response shape: no "triggers" list (keys: meta, links)',
    );
  });
});

describe('snapshotDirName', () => {
  it('names the folder after the subdomain and a filesystem-safe UTC timestamp', () => {
    expect(snapshotDirName('acme', new Date('2026-11-11T17:30:05.123Z'))).toBe(
      'acme-2026-11-11T17-30-05-123Z',
    );
  });

  it('sanitizes the subdomain', () => {
    expect(snapshotDirName('../x', new Date('2026-11-11T17:30:05.123Z'))).toBe(
      '___x-2026-11-11T17-30-05-123Z',
    );
  });
});
