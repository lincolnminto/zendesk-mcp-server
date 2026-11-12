import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { runGoldens } from '../../../src/export/goldens';
import { mswServer } from '../../setup';

const API = 'https://testsubdomain.zendesk.com/api/v2';
const json = async (dir: string, name: string) =>
  JSON.parse(await readFile(join(dir, name), 'utf8'));
const lines = async (dir: string, name: string) =>
  (await readFile(join(dir, name), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const setup = async (count = 3) => {
  const exportDir = await mkdtemp(join(tmpdir(), 'goldens-'));
  const folder = join(exportDir, 'data');
  await mkdir(join(folder, 'config'), { recursive: true });
  await writeFile(
    join(folder, 'manifest.json'),
    JSON.stringify({ started_at: '2025-12-01T00:00:00Z' }),
  );
  const tickets = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    status: i % 10 === 0 ? 'closed' : 'open',
    priority: 'high',
    group_id: 2,
  }));
  await writeFile(join(folder, 'tickets.ndjson'), tickets.map((t) => JSON.stringify(t)).join('\n'));
  for (const file of ['users', 'organizations', 'groups'])
    await writeFile(join(folder, `${file}.ndjson`), '');
  for (const file of ['brands', 'ticket_forms'])
    await writeFile(join(folder, 'config', `${file}.json`), '[]');
  let time = Date.parse('2026-01-01T00:00:00Z');
  return {
    subdomain: 'testsubdomain',
    getToken: () => 'token',
    exportDir,
    dataSnapshot: 'data',
    deps: {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
    },
  };
};

it('records a full GET-only run with isolated view and macro errors, pages, caps and searches', async () => {
  const opts = await setup();
  const requests: Request[] = [];
  mswServer.use(
    http.all(`${API}/*`, ({ request }) => {
      requests.push(request);
      const url = new URL(request.url);
      const path = url.pathname.slice('/api/v2'.length);
      const second = url.searchParams.get('page') === '2';
      if (path === '/users/me')
        return HttpResponse.json({ user: { id: 7, role: 'admin', name: 'Admin' } });
      if (path.endsWith('/group_memberships'))
        return HttpResponse.json({
          group_memberships: [{ id: second ? 2 : 1 }],
          next_page: second ? null : `${API}${path}?page=2`,
        });
      if (path === '/views')
        return HttpResponse.json({
          views: [
            { id: 1, active: true, restriction: null },
            { id: 2, active: true, restriction: { type: 'Group' } },
            { id: 3, active: true, restriction: { type: 'User' } },
            { id: 4, active: false, restriction: null },
          ],
        });
      if (path === '/views/2/count') return HttpResponse.json({ error: 'denied' }, { status: 403 });
      if (path.endsWith('/count')) return HttpResponse.json({ count: 3 });
      if (path === '/views/1/tickets')
        return HttpResponse.json({
          tickets: [{ id: second ? 3 : 1 }, ...(!second ? [{ id: 2 }] : [])],
          next_page: second ? null : `${API}${path}?page=2`,
        });
      if (path.endsWith('/execute'))
        return HttpResponse.json({
          view: { id: 1 },
          columns: ['id'],
          groups: [],
          rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
          count: 3,
        });
      if (path === '/macros')
        return HttpResponse.json({
          macros: [
            { id: 5, active: true, title: 'Macro', actions: [], restriction: null },
            { id: 6, active: false },
          ],
        });
      if (path.endsWith('/apply'))
        return path.includes('/tickets/2/')
          ? HttpResponse.json({ error: 'no' }, { status: 422 })
          : HttpResponse.json({ result: { ticket: { status: 'pending' } } });
      if (path === '/tickets/show_many')
        return HttpResponse.json({
          tickets: [
            { id: 2, status: 'open', slas: { policy: 8 } },
            { id: 3, status: 'open' },
          ],
          metric_sets: [
            { ticket_id: 3, id: 33 },
            { ticket_id: 2, id: 22 },
          ],
          metric_events: { '2': [{ id: 44 }] },
        });
      if (path.endsWith('/audits'))
        return HttpResponse.json({
          audits: [{ id: second ? 2 : 1 }],
          next_page: second ? null : `${API}${path}?page=2`,
        });
      if (path === '/search')
        return HttpResponse.json({ results: [{ id: url.searchParams.has('sort_by') ? 2 : 3 }] });
      return HttpResponse.json({}, { status: 404 });
    }),
  );
  const result = await runGoldens({
    ...opts,
    options: { viewRowCap: 2, macroSample: 3, slaSample: 2 },
  });
  expect(Object.values(result.manifest.stages).every((s) => s.status === 'done')).toBe(true);
  expect(await json(result.snapshot, 'context.json')).toMatchObject({
    user: { id: 7, name: 'Admin' },
    group_memberships: [{ id: 1 }, { id: 2 }],
  });
  expect(await json(result.snapshot, 'views/1.json')).toMatchObject({
    ticket_ids: [1, 2, 3],
    ticket_ids_total: 3,
    execute: { rows: [{ id: 1 }, { id: 2 }], rows_total_reported: 3, rows_truncated: true },
  });
  expect(await json(result.snapshot, 'views/index.json')).toHaveLength(2);
  expect(await json(result.snapshot, 'views/2.json')).toMatchObject({
    status: 'skipped',
    error: { status: 403 },
  });
  expect(await json(result.snapshot, 'macros/5.json')).toMatchObject({
    previews: expect.arrayContaining([
      { ticket_id: 2, error: { status: 422, body: '{"error":"no"}' } },
    ]),
  });
  expect(await lines(result.snapshot, 'slas.ndjson')).toMatchObject([
    { ticket_id: 2, metric_set: { id: 22 }, metric_events: [{ id: 44 }] },
    { ticket_id: 3, metric_set: { id: 33 }, metric_events: [] },
  ]);
  expect(await lines(result.snapshot, 'audits.ndjson')).toMatchObject([
    { audits: [{ id: 1 }, { id: 2 }] },
    { audits: [{ id: 1 }, { id: 2 }] },
  ]);
  expect((await json(result.snapshot, 'search.json'))[0]).toMatchObject({
    query: 'type:ticket status:new',
    count: { count: 3 },
    top_relevance_ids: [3],
    top_created_desc_ids: [2],
    origin: 'generated',
  });
  expect(requests.every((r) => r.method === 'GET' && r.url.startsWith(`${API}/`))).toBe(true);
  const before = requests.length;
  await runGoldens({ ...opts, resume: basename(result.snapshot) });
  expect(requests.length - before).toBe(1);
});

it('batches SLA tickets by 100, matches array sideloads, and keeps raw unknown events', {
  timeout: 20000,
}, async () => {
  const opts = await setup(125);
  const sizes: number[] = [];
  mswServer.use(
    http.get(`${API}/tickets/show_many`, ({ request }) => {
      const ids = new URL(request.url).searchParams.get('ids')?.split(',').map(Number) ?? [];
      sizes.push(ids.length);
      return HttpResponse.json({
        tickets: ids.map((id) => ({ id })),
        metric_sets: ids.map((ticket_id) => ({ ticket_id })),
        metric_events: [{ ticket_id: ids[0], event: 'x' }],
      });
    }),
    http.get(`${API}/tickets/:id/audits`, () => HttpResponse.json({ audits: [] })),
  );
  const result = await runGoldens({ ...opts, stages: ['slas'], options: { slaSample: 110 } });
  expect(sizes).toEqual([100, 10]);
  expect(await lines(result.snapshot, 'slas.ndjson')).toHaveLength(110);
  expect((await lines(result.snapshot, 'slas.ndjson'))[0].metric_events).toHaveLength(1);
});

it('resumes written views and macros without replaying their observations', async () => {
  const opts = await setup();
  const observed: string[] = [];
  mswServer.use(
    http.get(`${API}/*`, ({ request }) => {
      const path = new URL(request.url).pathname.slice('/api/v2'.length);
      if (path === '/users/me') return HttpResponse.json({ user: { id: 1, role: 'admin' } });
      if (path === '/views')
        return HttpResponse.json({
          views: [
            { id: 1, active: true, restriction: null },
            { id: 2, active: true, restriction: null },
          ],
        });
      if (path === '/macros')
        return HttpResponse.json({
          macros: [
            { id: 1, active: true },
            { id: 2, active: true },
          ],
        });
      observed.push(path);
      if (path.endsWith('/count')) return HttpResponse.json({ count: 0 });
      if (path.endsWith('/tickets')) return HttpResponse.json({ tickets: [] });
      if (path.endsWith('/execute'))
        return HttpResponse.json({ columns: [], groups: [], rows: [], count: 0 });
      if (path.endsWith('/apply')) return HttpResponse.json({ result: {} });
      return HttpResponse.json({}, { status: 404 });
    }),
  );
  const interrupted = new Set<string>();
  const result = await runGoldens({
    ...opts,
    stages: ['views', 'macros'],
    options: { macroSample: 0 },
    onProgress: (manifest) => {
      for (const name of ['views', 'macros'] as const)
        if (
          manifest.stages[name]?.status === 'running' &&
          manifest.stages[name]?.files[`${name}/1.json`] &&
          !interrupted.has(name)
        ) {
          interrupted.add(name);
          throw new Error('interrupted');
        }
    },
  });
  expect(result.manifest.stages.views?.status).toBe('failed');
  expect(result.manifest.stages.macros?.status).toBe('failed');
  observed.length = 0;
  const resumed = await runGoldens({ ...opts, resume: basename(result.snapshot) });
  expect(resumed.manifest.stages.views?.status).toBe('done');
  expect(resumed.manifest.stages.macros?.status).toBe('done');
  expect(observed).toEqual([
    '/views/2/count',
    '/views/2/tickets',
    '/views/2/execute',
    '/macros/2/apply',
  ]);
});

it.each([true, false])(
  'aborts an endpoint 401 only if users/me rejects it too: %s',
  async (rejected) => {
    const opts = await setup();
    let me = 0;
    mswServer.use(
      http.get(`${API}/users/me`, () => {
        me++;
        return rejected && me > 1
          ? HttpResponse.json({}, { status: 401 })
          : HttpResponse.json({ user: { id: 1, role: 'admin' } });
      }),
      http.get(`${API}/views`, () => HttpResponse.json({}, { status: 401 })),
    );
    const run = runGoldens({ ...opts, stages: ['views'] });
    if (rejected) await expect(run).rejects.toMatchObject({ status: 401 });
    else expect((await run).manifest.stages.views?.status).toBe('failed');
  },
);

it('records query-file origins, errors and safe raw unknown metric events', async () => {
  const opts = await setup();
  const queries = join(opts.exportDir, 'queries.json');
  await writeFile(
    queries,
    JSON.stringify([
      { id: 'custom', query: 'type:ticket status:open' },
      { id: 'failure', query: 'type:ticket bad' },
    ]),
  );
  mswServer.use(
    http.get(`${API}/search/count`, ({ request }) =>
      new URL(request.url).searchParams.get('query')?.endsWith('bad')
        ? HttpResponse.text('x'.repeat(600), { status: 422 })
        : HttpResponse.json({ count: 4 }),
    ),
    http.get(`${API}/search`, () => HttpResponse.json({ results: [] })),
    http.get(`${API}/tickets/show_many`, () =>
      HttpResponse.json({
        tickets: [{ id: 2 }],
        metric_sets: { unconfirmed: true },
        metric_events: { unconfirmed: true },
      }),
    ),
    http.get(`${API}/tickets/:id/audits`, () => HttpResponse.json({}, { status: 404 })),
  );
  const result = await runGoldens({
    ...opts,
    stages: ['search', 'slas'],
    options: { queries, slaSample: 1 },
  });
  expect((await json(result.snapshot, 'search.json'))[0]).toMatchObject({
    origin: 'file',
    id: 'custom',
  });
  expect((await json(result.snapshot, 'search.json'))[1].error.body).toHaveLength(500);
  expect((await lines(result.snapshot, 'slas.ndjson'))[0]).toMatchObject({
    metric_events: { unconfirmed: true },
    metric_set: { unconfirmed: true },
  });
  expect((await lines(result.snapshot, 'audits.ndjson'))[0]).toMatchObject({
    error: { status: 404 },
  });
});

it('keeps paging execute until the cap and reports untruncated complete output', async () => {
  const opts = await setup();
  const pages: string[] = [];
  mswServer.use(
    http.get(`${API}/views`, () =>
      HttpResponse.json({ views: [{ id: 1, active: true, restriction: null }] }),
    ),
    http.get(`${API}/views/1/count`, () => HttpResponse.json({ count: 3 })),
    http.get(`${API}/views/1/tickets`, () => HttpResponse.json({ tickets: [] })),
    http.get(`${API}/views/1/execute`, ({ request }) => {
      const url = new URL(request.url);
      pages.push(url.search);
      const second = url.searchParams.has('page[after]');
      return HttpResponse.json({
        columns: [],
        groups: [],
        rows: [{ ticket: { id: second ? 2 : 1 } }],
        count: 2,
        meta: { has_more: !second },
        links: { next: second ? null : `${API}/views/1/execute?page[after]=two&page[size]=100` },
      });
    }),
  );
  const result = await runGoldens({ ...opts, stages: ['views'], options: { viewRowCap: 3 } });
  expect(pages).toHaveLength(2);
  expect(pages[0]).toContain('page%5Bsize%5D=100');
  expect(await json(result.snapshot, 'views/1.json')).toMatchObject({
    execute: {
      rows: [{ ticket: { id: 1 } }, { ticket: { id: 2 } }],
      rows_truncated: false,
      rows_total_reported: 2,
    },
  });
});

it('rejects invalid paths/options before sign-in and foreign resume manifests', async () => {
  const opts = await setup();
  let tokens = 0;
  const getToken = () => {
    tokens++;
    return 'token';
  };
  for (const extra of [
    { subdomain: 'bad.domain' },
    { exportDir: 'relative' },
    { exportDir: '//network/share' },
    { dataSnapshot: '../escape' },
    { resume: '..' },
    { stages: [] },
    { stages: ['bad'] },
    { options: { macroSample: -1 } },
    { options: { queries: 'relative' } },
  ])
    await expect(
      runGoldens({ ...opts, getToken, ...extra } as Parameters<typeof runGoldens>[0]),
    ).rejects.toThrow();
  expect(tokens).toBe(0);
  mswServer.use(http.get(`${API}/views`, () => HttpResponse.json({}, { status: 403 })));
  const first = await runGoldens({ ...opts, stages: ['views'] });
  expect(first.manifest.stages.views?.status).toBe('skipped');
  const resume = basename(first.snapshot);
  for (const extra of [
    { dataSnapshot: 'different' },
    { stages: ['macros'] },
    { options: { macroSample: 3 } },
  ]) {
    if ('dataSnapshot' in extra) await mkdir(join(opts.exportDir, 'different'));
    await expect(
      runGoldens({ ...opts, resume, ...extra } as Parameters<typeof runGoldens>[0]),
    ).rejects.toThrow();
  }
  const original = first.manifest;
  for (const changes of [
    { kind: 'data' },
    { stages: { unknown: {} } },
    {
      stages: {
        views: { ...original.stages.views, files: { '../outside': { bytes: 0, lines: 0 } } },
      },
    },
  ]) {
    await writeFile(
      join(first.snapshot, 'manifest.json'),
      JSON.stringify({ ...original, ...changes }),
    );
    await expect(runGoldens({ ...opts, resume })).rejects.toThrow();
  }
  await writeFile(join(first.snapshot, 'manifest.json'), JSON.stringify(original));
  mswServer.use(
    http.get(`${API}/users/me`, () => HttpResponse.json({ user: { id: 999, role: 'admin' } })),
  );
  await expect(runGoldens({ ...opts, resume })).rejects.toThrow(/original recording user/);
});

it('records malformed pagination and invalid view ids without escaping the snapshot', async () => {
  const opts = await setup();
  mswServer.use(
    http.get(`${API}/views`, () =>
      HttpResponse.json({
        views: [
          { id: 1, active: true, restriction: null },
          { id: 2, active: true, restriction: null },
        ],
      }),
    ),
    http.get(`${API}/views/1/count`, () => HttpResponse.json({})),
    http.get(`${API}/views/1/tickets`, () =>
      HttpResponse.json({ tickets: [], next_page: `${API}/views/1/tickets?page=2` }),
    ),
    http.get(`${API}/views/2/count`, () => HttpResponse.json({}, { status: 404 })),
  );
  const result = await runGoldens({ ...opts, stages: ['views'] });
  expect(await json(result.snapshot, 'views/1.json')).toMatchObject({
    status: 'failed',
    error: { body: 'Error: Pagination made no progress' },
  });
  expect(await json(result.snapshot, 'views/2.json')).toMatchObject({
    status: 'skipped',
    error: { status: 404 },
  });
});

it('keeps committed SLA batches and audits on resume, removing uncommitted tails', async () => {
  const { appendFile } = await import('node:fs/promises');
  const opts = await setup();
  let batches = 0;
  let audits = 0;
  let interrupted = false;
  mswServer.use(
    http.get(`${API}/tickets/show_many`, () => {
      batches++;
      return HttpResponse.json({
        tickets: [{ id: 2 }, { id: 3 }],
        metric_sets: [],
        metric_events: [],
      });
    }),
    http.get(`${API}/tickets/:id/audits`, () => {
      audits++;
      return HttpResponse.json({ audits: [] });
    }),
  );
  const first = await runGoldens({
    ...opts,
    stages: ['slas'],
    options: { slaSample: 2 },
    onProgress: (manifest) => {
      if (manifest.stages.slas?.audit_offset === 1 && !interrupted) {
        interrupted = true;
        throw new Error('interrupted');
      }
    },
  });
  await appendFile(join(first.snapshot, 'slas.ndjson'), '{"ticket_id":999}\n');
  await appendFile(join(first.snapshot, 'audits.ndjson'), '{"ticket_id":999}\n');
  const resumed = await runGoldens({ ...opts, resume: basename(first.snapshot) });
  expect(resumed.manifest.stages.slas?.status).toBe('done');
  expect(batches).toBe(1);
  expect(audits).toBe(2);
  expect(await lines(first.snapshot, 'slas.ndjson')).toHaveLength(2);
  expect(await lines(first.snapshot, 'audits.ndjson')).toHaveLength(2);
});
