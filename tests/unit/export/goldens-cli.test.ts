import { expect, it } from 'vitest';
import { parseGoldensArgs } from '../../../src/export/cli';

it('parses golden stage selection, sample sizes and paths before auth', () => {
  const base = ['acme', '--export-dir', '/tmp/export', '--data-snapshot', 'data'];
  expect(
    parseGoldensArgs([
      ...base,
      '--only',
      'views',
      '--only',
      'search',
      '--view-row-cap',
      '7',
      '--macro-sample',
      '4',
      '--sla-sample',
      '10',
      '--queries',
      '/tmp/q.json',
      '--resume',
      'goldens',
    ]),
  ).toMatchObject({
    subdomain: 'acme',
    dataSnapshot: 'data',
    stages: ['views', 'search'],
    options: { viewRowCap: 7, macroSample: 4, slaSample: 10, queries: '/tmp/q.json' },
    resume: 'goldens',
  });
  for (const extra of [
    ['--only', 'tickets'],
    ['--view-row-cap', '-1'],
    ['--macro-sample', '1.5'],
    ['--queries', 'relative'],
    ['--resume', '../bad'],
    ['--since', '0'],
  ])
    expect(() => parseGoldensArgs([...base, ...extra])).toThrow();
  expect(() => parseGoldensArgs(['acme', '--export-dir', '/tmp/export'])).toThrow();
});

it.each([false, true])(
  'runs goldens with shared CLI auth, stderr progress and failure=%s',
  async (failed) => {
    const { mkdir, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { HttpResponse, http } = await import('msw');
    const { vi } = await import('vitest');
    const { mswServer } = await import('../../setup');
    const { runGoldensCli } = await import('../../../src/export/cli');
    const { defaultDeps } = await import('../../../src/export/rate-limit');
    const dir = await mkdtemp(join(tmpdir(), 'goldens-cli-'));
    await mkdir(join(dir, 'data'));
    let time = Date.parse('2026-01-01T00:00:00Z');
    vi.spyOn(defaultDeps, 'now').mockImplementation(() => time);
    vi.spyOn(defaultDeps, 'sleep').mockImplementation(async (ms) => {
      time += ms;
    });
    vi.stubEnv('ZENDESK_EMAIL', 'invented@example.test');
    vi.stubEnv('ZENDESK_API_TOKEN', 'invented-token');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const progress = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/users/:id/group_memberships', () =>
        failed
          ? HttpResponse.json({}, { status: 422 })
          : HttpResponse.json({ group_memberships: [] }),
      ),
    );
    try {
      expect(
        await runGoldensCli([
          'testsubdomain',
          '--export-dir',
          dir,
          '--data-snapshot',
          'data',
          '--only',
          'context',
        ]),
      ).toBe(failed ? 1 : 0);
      expect(JSON.parse(String(output.mock.calls[0]?.[0])).stages.context.status).toBe(
        failed ? 'failed' : 'done',
      );
      expect(progress).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  },
);

it('leaves unspecified sample options unset so resume inherits the original settings', () => {
  expect(
    parseGoldensArgs([
      'acme',
      '--export-dir',
      '/tmp/export',
      '--data-snapshot',
      'data',
      '--resume',
      'goldens',
    ]).options,
  ).toEqual({});
});
