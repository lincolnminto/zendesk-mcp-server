import { appendFile, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { CONFIG_RESOURCES } from '../../../src/export/account-config';
import { parseExportArgs } from '../../../src/export/cli';
import { parseSince, runDataExport } from '../../../src/export/data-export';
import { mswServer } from '../../setup';

const API = 'https://testsubdomain.zendesk.com/api/v2';
const clock = () => {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const waits: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
    waits,
  };
};
const options = async () => ({
  subdomain: 'testsubdomain',
  getToken: () => 'token',
  exportDir: await mkdtemp(join(tmpdir(), 'data-export-')),
  deps: clock(),
});
const lines = async (folder: string, file: string) =>
  (await readFile(join(folder, file), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe('bulk data export', () => {
  it('pages cursors, falls back includes, derives comments and attachments and deduplicates boundaries', async () => {
    const opts = await options();
    const calls: string[] = [];
    mswServer.use(
      http.get(`${API}/incremental/:stream`, ({ request, params }) => {
        const url = new URL(request.url);
        calls.push(url.search);
        if (params['stream'] === 'ticket_events') {
          const second = url.searchParams.get('start_time') === '5';
          const event = {
            id: 1,
            ticket_id: 9,
            timestamp: 5,
            child_events: [
              {
                id: 4,
                event_type: 'Comment',
                body: 'hello',
                attachments: [{ id: 7, content_url: 'https://elsewhere.test/file' }],
              },
            ],
          };
          return HttpResponse.json({
            ticket_events: second ? [event, { id: 2 }] : [event],
            end_time: 5,
            end_of_stream: second,
          });
        }
        return HttpResponse.json({}, { status: 404 });
      }),
      http.get(`${API}/incremental/tickets/cursor`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.has('include')) return HttpResponse.json({}, { status: 400 });
        const second = url.searchParams.has('cursor');
        return HttpResponse.json({
          tickets: [{ id: second ? 2 : 1, status: 'deleted' }],
          metric_sets: [{ id: 6 }],
          after_cursor: 'next',
          end_of_stream: second,
        });
      }),
    );
    const result = await runDataExport({ ...opts, streams: ['tickets', 'ticket_events'] });
    expect(await lines(result.snapshot, 'tickets.ndjson')).toHaveLength(2);
    expect(await lines(result.snapshot, 'ticket_events.ndjson')).toHaveLength(2);
    expect(await lines(result.snapshot, 'comments.ndjson')).toMatchObject([
      { ticket_id: 9, ticket_event_id: 1, timestamp: 5, id: 4 },
    ]);
    expect(await lines(result.snapshot, 'attachments.ndjson')).toMatchObject([
      { ticket_id: 9, comment_id: 4, id: 7 },
    ]);
    expect(result.manifest.streams.tickets?.include_used).toBe(null);
    expect(calls).toHaveLength(2);
  });

  it('keeps a newer version of a ticket that a cursor page repeats', async () => {
    const opts = await options();
    mswServer.use(
      http.get(`${API}/incremental/tickets/cursor`, ({ request }) => {
        const second = new URL(request.url).searchParams.has('cursor');
        return HttpResponse.json({
          tickets: [{ id: 1, status: second ? 'solved' : 'open' }],
          after_cursor: 'next',
          end_of_stream: second,
        });
      }),
    );
    const result = await runDataExport({ ...opts, streams: ['tickets'] });
    expect(await lines(result.snapshot, 'tickets.ndjson')).toEqual([
      { id: 1, status: 'open' },
      { id: 1, status: 'solved' },
    ]);
  });

  it('resumes from the committed cursor and truncates uncommitted bytes', async () => {
    const opts = await options();
    let fail = true;
    mswServer.use(
      http.get(`${API}/incremental/users/cursor`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (cursor && fail) return HttpResponse.json({}, { status: 422 });
        return HttpResponse.json({
          users: [{ id: cursor ? 2 : 1 }],
          after_cursor: 'saved',
          end_of_stream: Boolean(cursor),
        });
      }),
    );
    const first = await runDataExport({ ...opts, streams: ['users'] });
    expect(first.manifest.streams.users?.status).toBe('failed');
    await appendFile(join(first.snapshot, 'users.ndjson'), '{"id":999}\n');
    fail = false;
    const resumed = await runDataExport({ ...opts, resume: basename(first.snapshot) });
    expect(await lines(resumed.snapshot, 'users.ndjson')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(resumed.manifest.streams.users?.status).toBe('exported');
  });

  it('skips inaccessible streams, continues after failures, and never overwrites', async () => {
    const opts = await options();
    mswServer.use(
      http.get(`${API}/groups`, () => HttpResponse.json({}, { status: 403 })),
      http.get(`${API}/group_memberships`, () => HttpResponse.json({}, { status: 404 })),
      http.get(`${API}/organization_memberships`, () => HttpResponse.json({}, { status: 422 })),
      http.get(`${API}/satisfaction_ratings`, () =>
        HttpResponse.json({ satisfaction_ratings: [] }),
      ),
    );
    const result = await runDataExport({
      ...opts,
      streams: ['groups', 'group_memberships', 'organization_memberships', 'satisfaction_ratings'],
    });
    expect(Object.values(result.manifest.streams).map((s) => s.status)).toEqual([
      'skipped',
      'skipped',
      'failed',
      'exported',
    ]);
    const fixed = {
      ...opts,
      deps: { ...opts.deps, now: () => Date.parse(result.manifest.started_at) },
    };
    await expect(runDataExport(fixed)).rejects.toThrow();
    await expect(runDataExport({ ...opts, resume: '../escape' })).rejects.toThrow();
    expect(await readdir(opts.exportDir)).toHaveLength(1);
  });

  it('uses only GET on the account API throughout a full export', async () => {
    const opts = await options();
    const requests: Request[] = [];
    mswServer.use(
      http.all('*', ({ request }) => {
        requests.push(request);
        if (request.url.includes('/users/me'))
          return HttpResponse.json({ user: { id: 1, role: 'admin' } });
        if (request.url.includes('/incremental/')) {
          const key = new URL(request.url).pathname.split('/')[4];
          const events =
            key === 'ticket_events'
              ? [
                  {
                    id: 1,
                    ticket_id: 8,
                    timestamp: 4,
                    child_events: [
                      {
                        id: 3,
                        type: 'Comment',
                        attachments: [{ id: 5, content_url: 'https://external.test/content' }],
                      },
                    ],
                  },
                ]
              : [];
          return HttpResponse.json({ [key ?? '']: events, end_of_stream: true });
        }
        const path = new URL(request.url).pathname.slice('/api/v2'.length);
        const spec = Object.values(CONFIG_RESOURCES).find((entry) => entry.path === path);
        if (spec)
          return HttpResponse.json({ [spec.responseKey]: spec.single ? { enabled: true } : [] });
        if (path === '/tickets/side_conversations/events')
          return HttpResponse.json({ events: [], count: 0, end_time: 1 });
        if (path === '/custom_objects') return HttpResponse.json({ custom_objects: [] });
        if (path === '/organization_memberships' || path === '/satisfaction_ratings')
          return HttpResponse.json({ [path.slice(1)]: [] });
        return HttpResponse.json({}, { status: 404 });
      }),
    );
    const result = await runDataExport(opts);
    expect(Object.keys(result.manifest.streams)).toHaveLength(12);
    expect(
      Object.values(result.manifest.streams).every((stream) => stream.status === 'exported'),
    ).toBe(true);
    expect(requests.length).toBeGreaterThan(30);
    expect(requests.every((r) => r.method === 'GET' && r.url.startsWith(`${API}/`))).toBe(true);
  });
});

describe('export arguments', () => {
  it('parses repeated streams and validates before auth', () => {
    expect(
      parseExportArgs([
        'acme',
        '--export-dir',
        '/tmp/export',
        '--only',
        'users',
        '--only',
        'tickets',
        '--rate',
        '200',
      ]).streams,
    ).toEqual(['users', 'tickets']);
    for (const args of [
      [],
      ['--help'],
      ['acme', '--export-dir', 'relative'],
      ['acme', '--export-dir', '/tmp/a', '--unknown'],
      ['acme', '--export-dir', '/tmp/a', '--only', 'nope'],
      ['acme', '--export-dir', '/tmp/a', '--rate', '0'],
    ])
      expect(() => parseExportArgs(args)).toThrow();
  });
});

describe('bulk export edge cases', () => {
  it('uses the successful reduced ticket include and stores raw optional sideloads', async () => {
    const opts = await options();
    const includes: Array<string | null> = [];
    mswServer.use(
      http.get(`${API}/incremental/tickets/cursor`, ({ request }) => {
        const include = new URL(request.url).searchParams.get('include');
        includes.push(include);
        return include?.includes(',')
          ? HttpResponse.json({}, { status: 400 })
          : HttpResponse.json({
              tickets: [{ id: 1 }],
              metric_sets: [{ id: 2 }],
              slas: [{ id: 3, raw: true }],
              end_of_stream: true,
            });
      }),
    );
    const result = await runDataExport({
      ...opts,
      streams: ['tickets'],
      since: '2025-01-01T00:00:00Z',
    });
    expect(result.manifest.since).toBe(1735689600);
    expect(result.manifest.streams.tickets?.include_used).toBe('metric_sets');
    expect(includes).toEqual(['metric_sets,dates,slas', 'metric_sets']);
    expect(await lines(result.snapshot, 'ticket_metrics.ndjson')).toEqual([{ id: 2 }]);
    expect(await lines(result.snapshot, 'ticket_slas.ndjson')).toEqual([{ id: 3, raw: true }]);
  });

  it.each([true, false])('pages users and handles identities support=%s', async (supports) => {
    const opts = await options();
    mswServer.use(
      http.get(`${API}/incremental/users/cursor`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (!supports && query.has('include')) return HttpResponse.json({}, { status: 400 });
        const second = query.has('cursor');
        return HttpResponse.json({
          users: [{ id: second ? 2 : 1 }],
          ...(supports ? { identities: [{ id: second ? 4 : 3 }] } : {}),
          end_of_stream: second,
          after_cursor: 'u2',
        });
      }),
    );
    const result = await runDataExport({ ...opts, streams: ['users'] });
    expect(await lines(result.snapshot, 'users.ndjson')).toEqual([{ id: 1 }, { id: 2 }]);
    if (supports)
      expect(await lines(result.snapshot, 'user_identities.ndjson')).toEqual([
        { id: 3 },
        { id: 4 },
      ]);
    else expect(await readdir(result.snapshot)).not.toContain('user_identities.ndjson');
  });

  it('pages time streams by end_time and trusted next_page and standard streams by cursor then offset', async () => {
    const opts = await options();
    const requests: URL[] = [];
    mswServer.use(
      http.get(`${API}/incremental/:name`, ({ request, params }) => {
        const url = new URL(request.url);
        requests.push(url);
        const second = url.searchParams.get('start_time') === '10';
        const name = String(params['name']);
        return HttpResponse.json({
          [name]: [{ id: second ? 2 : 1 }],
          end_time: 10,
          ...(name === 'organizations'
            ? { next_page: `${API}/incremental/organizations?start_time=10` }
            : {}),
          end_of_stream: second,
        });
      }),
      http.get(`${API}/groups`, ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        if (url.searchParams.has('page[size]')) return HttpResponse.json({}, { status: 400 });
        const second = url.searchParams.get('page') === '2';
        return HttpResponse.json({
          groups: [{ id: second ? 2 : 1 }],
          next_page: second ? null : `${API}/groups?page=2`,
        });
      }),
      http.get(`${API}/group_memberships`, ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        const second = url.searchParams.has('page[after]');
        return HttpResponse.json({
          group_memberships: [{ id: second ? 2 : 1 }],
          meta: { has_more: !second },
          links: { next: second ? null : `${API}/group_memberships?page[after]=next` },
        });
      }),
    );
    const result = await runDataExport({
      ...opts,
      streams: ['organizations', 'ticket_metric_events', 'groups', 'group_memberships'],
      since: 4,
    });
    for (const name of ['organizations', 'ticket_metric_events', 'groups', 'group_memberships'])
      expect(await lines(result.snapshot, `${name}.ndjson`)).toHaveLength(2);
    expect(requests[0]?.searchParams.get('start_time')).toBe('4');
    expect(
      requests.find((url) => url.pathname.endsWith('/groups'))?.searchParams.has('start_time'),
    ).toBe(false);
  });

  it('stops short metric-event pages even if the API supplies a polling URL', async () => {
    const opts = await options();
    mswServer.use(
      http.get(`${API}/incremental/ticket_metric_events`, () =>
        HttpResponse.json({
          ticket_metric_events: [{ id: 1 }],
          next_page: `${API}/incremental/ticket_metric_events?start_time=5`,
          end_time: 5,
        }),
      ),
    );
    const result = await runDataExport({ ...opts, streams: ['ticket_metric_events'] });
    expect(result.manifest.streams.ticket_metric_events?.pages).toBe(1);
  });

  it('refuses pagination outside this account and malformed responses without stopping other streams', async () => {
    const opts = await options();
    mswServer.use(
      http.get(`${API}/groups`, () =>
        HttpResponse.json({ groups: [], next_page: 'https://evil.test/api/v2/groups' }),
      ),
      http.get(`${API}/group_memberships`, () => HttpResponse.json({ group_memberships: 'bad' })),
      http.get(`${API}/organization_memberships`, () =>
        HttpResponse.json({ organization_memberships: [] }),
      ),
    );
    const result = await runDataExport({
      ...opts,
      streams: ['groups', 'group_memberships', 'organization_memberships'],
    });
    expect(result.manifest.streams.groups?.reason).toContain('outside this account API');
    expect(result.manifest.streams.group_memberships?.reason).toContain('array');
    expect(result.manifest.streams.organization_memberships?.status).toBe('exported');
  });

  it.each([true, false])(
    'rethrows endpoint 401 only if users/me rejects the token=%s',
    async (rejected) => {
      const opts = await options();
      let meCalls = 0;
      mswServer.use(
        http.get(`${API}/users/me`, () => {
          meCalls += 1;
          return rejected && meCalls > 1
            ? HttpResponse.json({}, { status: 401 })
            : HttpResponse.json({ user: { id: 1, role: 'admin' } });
        }),
        http.get(`${API}/groups`, () => HttpResponse.json({}, { status: 401 })),
      );
      const run = runDataExport({ ...opts, streams: ['groups'] });
      if (rejected) await expect(run).rejects.toMatchObject({ status: 401 });
      else expect((await run).manifest.streams.groups?.status).toBe('failed');
      expect(meCalls).toBe(2);
    },
  );

  it('detects missing cursors, missing end times and stalled time pages', async () => {
    const opts = await options();
    mswServer.use(
      http.get(`${API}/incremental/tickets/cursor`, () =>
        HttpResponse.json({ tickets: [], end_of_stream: false }),
      ),
      http.get(`${API}/incremental/organizations`, () =>
        HttpResponse.json({ organizations: [], end_of_stream: false }),
      ),
      http.get(`${API}/incremental/ticket_events`, () =>
        HttpResponse.json({ ticket_events: [], end_time: 0, end_of_stream: false }),
      ),
    );
    const result = await runDataExport({
      ...opts,
      streams: ['tickets', 'organizations', 'ticket_events'],
    });
    expect(result.manifest.streams.tickets?.reason).toContain('cursor');
    expect(result.manifest.streams.organizations?.reason).toContain('end_time');
    expect(result.manifest.streams.ticket_events?.reason).toContain('no progress');
  });

  it('keeps event boundary deduplication after resume', async () => {
    const opts = await options();
    let fail = true;
    mswServer.use(
      http.get(`${API}/incremental/ticket_events`, ({ request }) => {
        const second = new URL(request.url).searchParams.get('start_time') === '5';
        if (second && fail) return HttpResponse.json({}, { status: 422 });
        const event = {
          id: 1,
          ticket_id: 8,
          timestamp: 5,
          child_events: [{ id: 3, type: 'Comment', attachments: [{ id: 9 }] }, { type: 'Change' }],
        };
        return HttpResponse.json({
          ticket_events: second ? [event, { id: 2 }] : [event],
          end_time: 5,
          end_of_stream: second,
        });
      }),
    );
    const first = await runDataExport({ ...opts, streams: ['ticket_events'] });
    await appendFile(join(first.snapshot, 'comments.ndjson'), '{"id":999}\n');
    await appendFile(join(first.snapshot, 'attachments.ndjson'), '{"id":999}\n');
    fail = false;
    const resumed = await runDataExport({ ...opts, resume: basename(first.snapshot) });
    expect(await lines(resumed.snapshot, 'comments.ndjson')).toHaveLength(1);
    expect(await lines(resumed.snapshot, 'attachments.ndjson')).toHaveLength(1);
    expect(await lines(resumed.snapshot, 'ticket_events.ndjson')).toHaveLength(2);
  });
});

describe('snapshot integrity and configuration resume', () => {
  it('resumes .json pagination links without replaying the first page', async () => {
    const opts = await options();
    let failing = true;
    let firstCalls = 0;
    mswServer.use(
      http.get(`${API}/groups`, () => {
        firstCalls += 1;
        return HttpResponse.json({ groups: [{ id: 1 }], next_page: `${API}/groups.json?page=2` });
      }),
      http.get(`${API}/groups.json`, () =>
        failing
          ? HttpResponse.json({}, { status: 422 })
          : HttpResponse.json({ groups: [{ id: 2 }], next_page: null }),
      ),
    );
    const first = await runDataExport({ ...opts, streams: ['groups'] });
    failing = false;
    const result = await runDataExport({ ...opts, resume: basename(first.snapshot) });
    expect(await lines(result.snapshot, 'groups.ndjson')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(firstCalls).toBe(1);
  });

  it('checkpoints configuration per resource and retries only failed resources', async () => {
    const opts = await options();
    let failing = true;
    let triggerCalls = 0;
    const requests: string[] = [];
    mswServer.use(
      http.get(`${API}/*`, ({ request }) => {
        const path = new URL(request.url).pathname.slice('/api/v2'.length);
        requests.push(path);
        if (path === '/users/me') return HttpResponse.json({ user: { id: 1, role: 'admin' } });
        if (path === '/triggers') {
          triggerCalls += 1;
          return HttpResponse.json({ triggers: [{ id: 3 }] });
        }
        if (path === '/brands')
          return failing
            ? HttpResponse.json({}, { status: 422 })
            : HttpResponse.json({ brands: [{ id: 8 }] });
        return HttpResponse.json({}, { status: 404 });
      }),
    );
    const first = await runDataExport({ ...opts, streams: ['config'] });
    expect(first.manifest.streams.config?.status).toBe('failed');
    expect(first.manifest.streams.config?.files['config/triggers.json']).toEqual({
      lines: 5,
      bytes: 24,
    });
    failing = false;
    requests.length = 0;
    const result = await runDataExport({ ...opts, resume: basename(first.snapshot) });
    expect(result.manifest.streams.config?.status).toBe('exported');
    expect(requests).toEqual(['/users/me', '/brands']);
    expect(triggerCalls).toBe(1);
    expect(result.manifest.streams.config?.files['config/brands.json']?.lines).toBe(5);
  });

  it('rejects unsafe paths and invalid stream selection before authentication', async () => {
    const opts = await options();
    const invalid = [
      { subdomain: 'bad.domain' },
      { exportDir: 'relative' },
      { exportDir: '//remote/path' },
      { streams: [] },
      { streams: ['bad'] },
      { since: 'bad' },
    ];
    for (const extra of invalid)
      await expect(
        runDataExport({ ...opts, ...extra } as Parameters<typeof runDataExport>[0]),
      ).rejects.toThrow();
    expect(await readdir(opts.exportDir)).toEqual([]);
    expect(parseSince('0')).toBe(0);
    expect(parseSince('2025-01-01')).toBe(1735689600);
    for (const value of [-1, 0.5, 'yesterday', '2025-13-32', Number.POSITIVE_INFINITY])
      expect(() => parseSince(value)).toThrow();
  });

  it('rejects changed dates, streams, corrupted checkpoints, and foreign manifests on resume', async () => {
    const opts = await options();
    mswServer.use(http.get(`${API}/groups`, () => HttpResponse.json({}, { status: 422 })));
    const first = await runDataExport({ ...opts, streams: ['groups'], since: '3' });
    const resume = basename(first.snapshot);
    await expect(runDataExport({ ...opts, resume, since: '4' })).rejects.toThrow(/Since/);
    await expect(runDataExport({ ...opts, resume, streams: ['users'] })).rejects.toThrow(
      /original snapshot/,
    );
    const original = JSON.stringify(first.manifest);
    const cases = [
      { ...first.manifest, subdomain: 'other' },
      { ...first.manifest, kind: 'config' },
      { ...first.manifest, streams: { bogus: {} } },
      {
        ...first.manifest,
        streams: { groups: { ...first.manifest.streams.groups, position: {} } },
      },
      {
        ...first.manifest,
        streams: {
          groups: {
            ...first.manifest.streams.groups,
            position: { request: { path: '/../../outside', params: {} }, previous_ids: [] },
          },
        },
      },
      {
        ...first.manifest,
        streams: {
          groups: {
            ...first.manifest.streams.groups,
            position: { request: { path: '/groups', params: { key: 2 } }, previous_ids: [] },
          },
        },
      },
      {
        ...first.manifest,
        streams: {
          groups: {
            ...first.manifest.streams.groups,
            files: { '../outside': { bytes: 0, lines: 0 } },
          },
        },
      },
    ];
    for (const manifest of cases) {
      await writeFile(join(first.snapshot, 'manifest.json'), JSON.stringify(manifest));
      await expect(runDataExport({ ...opts, resume })).rejects.toThrow();
    }
    await writeFile(join(first.snapshot, 'manifest.json'), original);
    const result = await runDataExport({
      ...opts,
      resume,
      rates: { standard: 200 },
      streams: ['groups'],
    });
    expect(result.manifest.rates.standard).toBe(200);
  });

  it('rejects symlink resume folders and truncated files without writing outside the snapshot', async () => {
    const opts = await options();
    const other = await mkdtemp(join(tmpdir(), 'other-snapshot-'));
    await symlink(other, join(opts.exportDir, 'linked'));
    await expect(runDataExport({ ...opts, resume: 'linked' })).rejects.toThrow(/real local/);
    expect(await readdir(other)).toEqual([]);
  });
});

it('preserves an unconfirmed SLA sideload object without assuming an array schema', async () => {
  const opts = await options();
  mswServer.use(
    http.get(`${API}/incremental/tickets/cursor`, () =>
      HttpResponse.json({
        tickets: [],
        metric_sets: [],
        slas: { ticket_id: 1, policies: [{ id: 3 }] },
        end_of_stream: true,
      }),
    ),
  );
  const result = await runDataExport({ ...opts, streams: ['tickets'] });
  expect(result.manifest.streams.tickets?.status).toBe('exported');
  expect(await lines(result.snapshot, 'ticket_slas.ndjson')).toEqual([
    { ticket_id: 1, policies: [{ id: 3 }] },
  ]);
});

describe('additional data streams', () => {
  it.each(['link', 'end_time'])(
    'keeps all support types on every request using %s pagination',
    async (pagination) => {
      const opts = await options();
      const requests: URL[] = [];
      mswServer.use(
        http.get(`${API}/incremental/tickets/cursor`, ({ request }) => {
          const url = new URL(request.url);
          requests.push(url);
          const second = url.searchParams.has('cursor');
          return HttpResponse.json({
            tickets: [{ id: second ? 2 : 1 }],
            after_cursor: 'next',
            end_of_stream: second,
          });
        }),
        http.get(`${API}/incremental/ticket_events`, ({ request }) => {
          const url = new URL(request.url);
          requests.push(url);
          const second = url.searchParams.get('start_time') === '5';
          return HttpResponse.json({
            ticket_events: [{ id: second ? 2 : 1 }],
            end_time: 5,
            end_of_stream: second,
            ...(pagination === 'link'
              ? {
                  next_page: `${API}/incremental/ticket_events?start_time=5&support_type_scope=agent`,
                }
              : {}),
          });
        }),
      );
      const result = await runDataExport({ ...opts, streams: ['tickets', 'ticket_events'] });
      expect(requests).toHaveLength(4);
      expect(requests.every((url) => url.searchParams.get('support_type_scope') === 'all')).toBe(
        true,
      );
      expect(await lines(result.snapshot, 'tickets.ndjson')).toHaveLength(2);
      expect(await lines(result.snapshot, 'ticket_events.ndjson')).toHaveLength(2);
    },
  );

  it('resumes custom record cursors across objects and definition pages without replaying committed pages', async () => {
    const opts = await options();
    const requests: URL[] = [];
    let fail = true;
    mswServer.use(
      http.get(`${API}/custom_objects`, ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        const second = url.searchParams.has('page[after]');
        return HttpResponse.json({
          custom_objects: [{ key: second ? 'devices' : 'cars' }],
          meta: { has_more: !second },
          links: { next: `${API}/custom_objects?page[after]=objects2` },
        });
      }),
      http.get(`${API}/custom_objects/:key/records`, ({ request, params }) => {
        const url = new URL(request.url);
        requests.push(url);
        const second = url.searchParams.has('page[after]');
        if (second && fail) return HttpResponse.json({}, { status: 422 });
        return HttpResponse.json({
          custom_object_records: [{ id: second ? 'r2' : 'r1', name: 'Invented record' }],
          meta: { has_more: params['key'] === 'cars' && !second },
          links: { next: `${API}/custom_objects/${params['key']}/records?page[after]=records2` },
        });
      }),
    );
    const first = await runDataExport({ ...opts, streams: ['custom_object_records'], since: 99 });
    expect(first.manifest.streams.custom_object_records?.status).toBe('failed');
    expect(await lines(first.snapshot, 'custom_object_records.ndjson')).toEqual([
      { id: 'r1', name: 'Invented record', custom_object_key: 'cars' },
    ]);
    await appendFile(
      join(first.snapshot, 'custom_object_records.ndjson'),
      '{"id":"uncommitted"}\n',
    );
    requests.length = 0;
    fail = false;
    const result = await runDataExport({ ...opts, resume: basename(first.snapshot) });
    expect(result.manifest.streams.custom_object_records?.status).toBe('exported');
    expect(requests.map((url) => url.pathname)).toEqual([
      '/api/v2/custom_objects/cars/records',
      '/api/v2/custom_objects',
      '/api/v2/custom_objects/devices/records',
    ]);
    expect(
      requests.every(
        (url) =>
          url.searchParams.get('page[size]') === '100' && !url.searchParams.has('start_time'),
      ),
    ).toBe(true);
    expect(await lines(result.snapshot, 'custom_object_records.ndjson')).toEqual([
      { id: 'r1', name: 'Invented record', custom_object_key: 'cars' },
      { id: 'r2', name: 'Invented record', custom_object_key: 'cars' },
      { id: 'r1', name: 'Invented record', custom_object_key: 'devices' },
    ]);
  });

  it('resumes side events with boundary deduplication and reads each conversation once per snapshot', async () => {
    const opts = await options();
    let fail = true;
    const requests: URL[] = [];
    const conversations: string[] = [];
    const requestTimes: number[] = [];
    const firstEvent = { id: 'e1', ticket_id: 8, side_conversation_id: 'sc1', type: 'reply' };
    const secondEvent = { id: 'e2', ticket_id: 8, side_conversation_id: 'sc1', type: 'update' };
    const thirdEvent = { id: 'e3', ticket_id: 9, side_conversation_id: 'sc1', type: 'create' };
    mswServer.use(
      http.get(`${API}/tickets/side_conversations/events`, ({ request }) => {
        requestTimes.push(opts.deps.now());
        const url = new URL(request.url);
        requests.push(url);
        const second = url.searchParams.get('start_time') === '5';
        if (second && fail) return HttpResponse.json({}, { status: 422 });
        return HttpResponse.json({
          events: second ? [firstEvent, secondEvent, thirdEvent] : [firstEvent],
          end_time: 5,
          end_of_stream: second,
          next_page: `${API}/tickets/side_conversations/events?start_time=5`,
        });
      }),
      http.get(`${API}/tickets/:ticket/side_conversations/:id`, ({ params }) => {
        conversations.push(`${params['ticket']}/${params['id']}`);
        return HttpResponse.json({
          side_conversation: { id: params['id'], subject: 'Invented conversation' },
        });
      }),
    );
    const first = await runDataExport({ ...opts, streams: ['side_conversation_events'], since: 3 });
    expect(first.manifest.streams.side_conversation_events?.status).toBe('failed');
    expect(
      first.manifest.streams.side_conversation_events?.position.request?.params['start_time'],
    ).toBe('5');
    await appendFile(
      join(first.snapshot, 'side_conversation_events.ndjson'),
      '{"id":"uncommitted"}\n',
    );
    await appendFile(join(first.snapshot, 'side_conversations.ndjson'), '{"id":"uncommitted"}\n');
    fail = false;
    const result = await runDataExport({ ...opts, resume: basename(first.snapshot) });
    expect(result.manifest.streams.side_conversation_events?.status).toBe('exported');
    expect(await lines(result.snapshot, 'side_conversation_events.ndjson')).toEqual([
      firstEvent,
      secondEvent,
      thirdEvent,
    ]);
    expect(await lines(result.snapshot, 'side_conversations.ndjson')).toEqual([
      { id: 'sc1', subject: 'Invented conversation', ticket_id: 8 },
      { id: 'sc1', subject: 'Invented conversation', ticket_id: 9 },
    ]);
    expect(conversations).toEqual(['8/sc1', '9/sc1']);
    expect(requests.map((url) => url.searchParams.get('start_time'))).toEqual(['3', '5', '5']);
    expect((requestTimes[1] ?? 0) - (requestTimes[0] ?? 0)).toBe(6000);
  });

  it('stops repeated side event polling pages and deduplicates conversations within a page', async () => {
    const opts = await options();
    let calls = 0;
    let lookups = 0;
    mswServer.use(
      http.get(`${API}/tickets/side_conversations/events`, () => {
        calls += 1;
        return HttpResponse.json({
          events: [
            { id: 'e1', ticket_id: 8, side_conversation_id: 'sc1' },
            { id: 'e2', ticket_id: 8, side_conversation_id: 'sc1' },
          ],
          count: 2,
          end_time: 5,
          next_page: `${API}/tickets/side_conversations/events?start_time=5`,
        });
      }),
      http.get(`${API}/tickets/8/side_conversations/sc1`, () => {
        lookups += 1;
        return HttpResponse.json({ side_conversation: { id: 'sc1' } });
      }),
    );
    const result = await runDataExport({ ...opts, streams: ['side_conversation_events'] });
    expect(result.manifest.streams.side_conversation_events?.status).toBe('exported');
    expect(calls).toBe(2);
    expect(lookups).toBe(1);
    expect(await lines(result.snapshot, 'side_conversations.ndjson')).toEqual([
      { id: 'sc1', ticket_id: 8 },
    ]);
  });

  it.each([403, 404])(
    'skips side conversations without the add-on (HTTP %s) and continues',
    async (status) => {
      const opts = await options();
      mswServer.use(
        http.get(`${API}/tickets/side_conversations/events`, () =>
          HttpResponse.json({}, { status }),
        ),
        http.get(`${API}/groups`, () => HttpResponse.json({ groups: [{ id: 1 }] })),
      );
      const result = await runDataExport({
        ...opts,
        streams: ['side_conversation_events', 'groups'],
      });
      expect(result.manifest.streams.side_conversation_events).toMatchObject({
        status: 'skipped',
        reason: expect.any(String),
        requests: 1,
      });
      expect(result.manifest.streams.groups?.status).toBe('exported');
    },
  );
});

it('retries an uncommitted side event page if a conversation lookup fails', async () => {
  const opts = await options();
  let fail = true;
  const lookups: string[] = [];
  const events = [
    { id: 'e1', ticket_id: 8, side_conversation_id: 'sc1' },
    { id: 'e2', ticket_id: 8, side_conversation_id: 'sc2' },
  ];
  mswServer.use(
    http.get(`${API}/tickets/side_conversations/events`, () =>
      HttpResponse.json({ events, end_of_stream: true }),
    ),
    http.get(`${API}/tickets/8/side_conversations/:id`, ({ params }) => {
      const id = String(params['id']);
      lookups.push(id);
      return fail && id === 'sc2'
        ? HttpResponse.json({}, { status: 422 })
        : HttpResponse.json({ side_conversation: { id } });
    }),
  );
  const first = await runDataExport({ ...opts, streams: ['side_conversation_events'] });
  expect(first.manifest.streams.side_conversation_events?.status).toBe('failed');
  expect(first.manifest.streams.side_conversation_events?.files).toEqual({});
  fail = false;
  const result = await runDataExport({ ...opts, resume: basename(first.snapshot) });
  expect(result.manifest.streams.side_conversation_events?.status).toBe('exported');
  expect(await lines(result.snapshot, 'side_conversation_events.ndjson')).toEqual(events);
  expect(await lines(result.snapshot, 'side_conversations.ndjson')).toEqual([
    { id: 'sc1', ticket_id: 8 },
    { id: 'sc2', ticket_id: 8 },
  ]);
  expect(lookups).toEqual(['sc1', 'sc2', 'sc1', 'sc2']);
});

it('exports every object on a definition page even when preceding objects have no records', async () => {
  const opts = await options();
  const keys: string[] = [];
  mswServer.use(
    http.get(`${API}/custom_objects`, () =>
      HttpResponse.json({
        custom_objects: [{ key: 'cars' }, { key: 'devices' }],
        meta: { has_more: false },
      }),
    ),
    http.get(`${API}/custom_objects/:key/records`, ({ params }) => {
      keys.push(String(params['key']));
      return HttpResponse.json({
        custom_object_records: params['key'] === 'cars' ? [] : [{ id: 'r1' }],
        meta: { has_more: false },
      });
    }),
  );
  const result = await runDataExport({ ...opts, streams: ['custom_object_records'] });
  expect(result.manifest.streams.custom_object_records?.status).toBe('exported');
  expect(keys).toEqual(['cars', 'devices']);
  expect(await lines(result.snapshot, 'custom_object_records.ndjson')).toEqual([
    { id: 'r1', custom_object_key: 'devices' },
  ]);
});

it('pages full side event batches without end_of_stream and stops at the short polling page', async () => {
  const opts = await options();
  let pages = 0;
  let lookups = 0;
  const events = Array.from({ length: 1000 }, (_, id) => ({
    id: `e${id}`,
    ticket_id: 8,
    side_conversation_id: 'sc1',
  }));
  mswServer.use(
    http.get(`${API}/tickets/side_conversations/events`, ({ request }) => {
      pages += 1;
      const second = new URL(request.url).searchParams.get('start_time') === '5';
      return HttpResponse.json({
        events: second ? [events[999]] : events,
        count: second ? 1 : 1000,
        end_time: 5,
        next_page: `${API}/tickets/side_conversations/events?start_time=5`,
      });
    }),
    http.get(`${API}/tickets/8/side_conversations/sc1`, () => {
      lookups += 1;
      return HttpResponse.json({ side_conversation: { id: 'sc1' } });
    }),
  );
  const result = await runDataExport({ ...opts, streams: ['side_conversation_events'] });
  expect(result.manifest.streams.side_conversation_events?.status).toBe('exported');
  expect(pages).toBe(2);
  expect(lookups).toBe(1);
  expect(await lines(result.snapshot, 'side_conversation_events.ndjson')).toHaveLength(1000);
  expect(await lines(result.snapshot, 'side_conversations.ndjson')).toHaveLength(1);
});

it('follows short side event pages until next_page is null without assuming a page size', async () => {
  const opts = await options();
  let pages = 0;
  let lookups = 0;
  mswServer.use(
    http.get(`${API}/tickets/side_conversations/events`, ({ request }) => {
      pages += 1;
      const second = new URL(request.url).searchParams.get('start_time') === '5';
      return HttpResponse.json({
        events: [{ id: second ? 'e2' : 'e1', ticket_id: 8, side_conversation_id: 'sc1' }],
        count: 1,
        end_time: 5,
        next_page: second ? null : `${API}/tickets/side_conversations/events?start_time=5`,
      });
    }),
    http.get(`${API}/tickets/8/side_conversations/sc1`, () => {
      lookups += 1;
      return HttpResponse.json({ side_conversation: { id: 'sc1' } });
    }),
  );
  const result = await runDataExport({ ...opts, streams: ['side_conversation_events'] });
  expect(result.manifest.streams.side_conversation_events?.status).toBe('exported');
  expect(pages).toBe(2);
  expect(lookups).toBe(1);
  expect(await lines(result.snapshot, 'side_conversation_events.ndjson')).toHaveLength(2);
});
