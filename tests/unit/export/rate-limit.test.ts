import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRetryDeps } from '../../../src/client/retry';
import { createPacedGet, defaultDeps, resolveRates } from '../../../src/export/rate-limit';
import { mswServer } from '../../setup';

const API = 'https://testsubdomain.zendesk.com/api/v2';
const fakeClock = () => {
  let at = 0;
  const waits: number[] = [];
  return {
    now: () => at,
    sleep: async (ms: number) => {
      waits.push(ms);
      at += ms;
    },
    waits,
  };
};
afterEach(() => vi.restoreAllMocks());

describe('bulk export pacing', () => {
  it('reserves independent buckets and paces each request including retry attempts', async () => {
    const clock = fakeClock();
    let count = 0;
    const times: number[] = [];
    mswServer.use(
      http.get(`${API}/incremental/tickets/cursor`, () => {
        times.push(clock.now());
        count += 1;
        return count === 1
          ? HttpResponse.json({}, { status: 429, headers: { 'Retry-After': '60' } })
          : HttpResponse.json({ tickets: [] });
      }),
    );
    const get = createPacedGet('testsubdomain', () => 'token', {}, clock);
    await get('incremental', '/incremental/tickets/cursor');
    await get('incremental', '/incremental/tickets/cursor');
    await get('standard', '/users/me');
    await get('standard', '/users/me');
    expect(times).toEqual([0, 60_000, 66_000]);
    expect(clock.waits).toEqual([60_000, 6000, 200]);
  });

  it('limits 429 retries to ten and honors an injectable backoff plus pacing', async () => {
    const clock = { ...fakeClock(), rateLimitWaitMs: 50 };
    let requests = 0;
    mswServer.use(
      http.get(`${API}/groups`, () => {
        requests += 1;
        return HttpResponse.json({}, { status: 429, headers: { 'Retry-After': '60' } });
      }),
    );
    const get = createPacedGet('testsubdomain', () => 'token', {}, clock);
    await expect(get('standard', '/groups')).rejects.toMatchObject({ status: 429 });
    expect(requests).toBe(11);
    expect(clock.waits).toHaveLength(20);
    expect(clock.waits.slice(0, 2)).toEqual([50, 150]);
  });

  it.each(['server', 'network'] as const)(
    'retries %s errors five times after client retries',
    async (kind) => {
      vi.spyOn(defaultRetryDeps, 'sleep').mockResolvedValue();
      const clock = fakeClock();
      let requests = 0;
      mswServer.use(
        http.get(`${API}/groups`, () => {
          requests += 1;
          return kind === 'server' ? HttpResponse.json({}, { status: 503 }) : HttpResponse.error();
        }),
      );
      const get = createPacedGet('testsubdomain', () => 'token', {}, clock);
      await expect(get('standard', '/groups')).rejects.toBeInstanceOf(Error);
      expect(requests).toBe(18);
      expect(clock.waits).toEqual([30_000, 30_000, 30_000, 30_000, 30_000]);
    },
  );

  it('recovers from a server error using injected waits and propagates non-retryable errors', async () => {
    vi.spyOn(defaultRetryDeps, 'sleep').mockResolvedValue();
    const clock = { ...fakeClock(), errorWaitMs: 1000 };
    let requests = 0;
    mswServer.use(
      http.get(`${API}/groups`, () => {
        requests += 1;
        return requests <= 3
          ? HttpResponse.json({}, { status: 500 })
          : HttpResponse.json({ groups: [] });
      }),
    );
    const get = createPacedGet('testsubdomain', () => 'token', { standard: 60 }, clock);
    await expect(get('standard', '/groups')).resolves.toEqual({ groups: [] });
    expect(clock.waits).toEqual([1000]);
    mswServer.use(http.get(`${API}/groups`, () => HttpResponse.json({}, { status: 422 })));
    await expect(get('standard', '/groups')).rejects.toMatchObject({ status: 422 });
  });

  it('validates rates and exposes a working default clock without real sleeps', async () => {
    expect(resolveRates()).toEqual({ incremental: 10, standard: 300 });
    for (const standard of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => resolveRates({ standard })).toThrow();
    vi.useFakeTimers();
    try {
      const wait = defaultDeps.sleep(50);
      await vi.advanceTimersByTimeAsync(50);
      await wait;
      expect(Number.isFinite(defaultDeps.now())).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
