import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tokenStore from '../../../src/auth/token-store';
import { parseExportArgs, runExportCli, waitForExportToken } from '../../../src/export/cli';
import { defaultDeps } from '../../../src/export/rate-limit';
import { mswServer } from '../../setup';

const API = 'https://testsubdomain.zendesk.com/api/v2';
const clock = () => {
  let time = Date.parse('2026-01-01T00:00:00Z');
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('export CLI', () => {
  it('validates since, resume, logging, subdomain and local directory', () => {
    const args = ['testsubdomain', '--export-dir', '/tmp/export'];
    expect(
      parseExportArgs([
        ...args,
        '--since',
        '2025-01-01',
        '--resume',
        'old',
        '--log-level',
        'debug',
      ]),
    ).toMatchObject({ since: '2025-01-01', resume: 'old', logLevel: 'debug' });
    for (const flags of [
      ['--resume', '..'],
      ['--since', 'garbage'],
      ['--log-level', 'nope'],
      ['--rate', 'NaN'],
    ])
      expect(() => parseExportArgs([...args, ...flags])).toThrow();
    expect(() => parseExportArgs(['bad.domain', '--export-dir', '/tmp/x'])).toThrow();
    expect(() => parseExportArgs(['testsubdomain', '--export-dir', '//network/x'])).toThrow();
    expect(() => parseExportArgs([...args, 'extra'])).toThrow();
  });

  it('polls authorization every three seconds, prints a URL once, and times out after ten minutes', async () => {
    const deps = clock();
    const log = vi.fn();
    let calls = 0;
    const get = () => {
      calls += 1;
      if (calls < 3) throw tokenStore.createAuthRequiredError('https://authorize.test/');
      return 'token';
    };
    await expect(waitForExportToken(get, log, deps)).resolves.toBe('token');
    expect(calls).toBe(3);
    expect(log).toHaveBeenCalledTimes(1);
    const start = deps.now();
    await expect(
      waitForExportToken(
        () => {
          throw tokenStore.createAuthRequiredError('https://authorize.test/');
        },
        log,
        deps,
      ),
    ).rejects.toThrow(/Timed out/);
    expect(deps.now() - start).toBe(600_000);
    await expect(
      waitForExportToken(
        () => {
          throw new Error('auth broken');
        },
        log,
        deps,
      ),
    ).rejects.toThrow('auth broken');
  });

  it.each([false, true])(
    'runs with static API-token auth and returns failure=%s',
    async (failed) => {
      const deps = clock();
      vi.spyOn(defaultDeps, 'now').mockImplementation(deps.now);
      vi.spyOn(defaultDeps, 'sleep').mockImplementation(deps.sleep);
      vi.stubEnv('ZENDESK_EMAIL', 'invented@example.test');
      vi.stubEnv('ZENDESK_API_TOKEN', 'invented-token');
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const progress = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const headers: string[] = [];
      mswServer.use(
        http.get(`${API}/groups`, ({ request }) => {
          headers.push(request.headers.get('authorization') ?? '');
          return failed
            ? HttpResponse.json({}, { status: 422 })
            : HttpResponse.json({ groups: [{ id: 1 }] });
        }),
      );
      const root = await mkdtemp(join(tmpdir(), 'cli-export-'));
      expect(await runExportCli(['testsubdomain', '--export-dir', root, '--only', 'groups'])).toBe(
        failed ? 1 : 0,
      );
      const summary = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(summary.snapshot).toContain(root);
      expect(summary.streams.groups.status).toBe(failed ? 'failed' : 'exported');
      expect(headers[0]).toBe(
        `Basic ${Buffer.from('invented@example.test/token:invented-token').toString('base64')}`,
      );
      expect(progress).toHaveBeenCalled();
    },
  );

  it('uses read-only OAuth, prints the pending URL, and disposes auth on errors', async () => {
    const deps = clock();
    vi.spyOn(defaultDeps, 'now').mockImplementation(deps.now);
    vi.spyOn(defaultDeps, 'sleep').mockImplementation(deps.sleep);
    vi.stubEnv('ZENDESK_EMAIL', undefined);
    vi.stubEnv('ZENDESK_API_TOKEN', undefined);
    const dispose = vi.fn();
    let calls = 0;
    const create = vi.spyOn(tokenStore, 'createTokenStore').mockReturnValue({
      getToken: async () => {
        calls += 1;
        if (calls === 1) throw tokenStore.createAuthRequiredError('https://authorize.test/');
        return 'token';
      },
      dispose,
      invalidate: vi.fn(),
      setToken: vi.fn(),
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const root = await mkdtemp(join(tmpdir(), 'cli-oauth-'));
    mswServer.use(http.get(`${API}/groups`, () => HttpResponse.json({ groups: [] })));
    expect(await runExportCli(['testsubdomain', '--export-dir', root, '--only', 'groups'])).toBe(0);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ readOnly: true });
    expect(log.mock.calls.flat()).toContain('Authorize read-only export: https://authorize.test/');
    expect(dispose).toHaveBeenCalledOnce();
    create.mockReturnValue({
      getToken: async () => {
        throw new Error('invalid sign-in');
      },
      dispose,
      invalidate: vi.fn(),
      setToken: vi.fn(),
    });
    await expect(
      runExportCli(['testsubdomain', '--export-dir', root, '--only', 'groups']),
    ).rejects.toThrow('invalid sign-in');
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
