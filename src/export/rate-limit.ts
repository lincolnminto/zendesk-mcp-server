import { isZendeskNetworkError } from '../client/retry';
import { ZendeskApiError, zendeskGet } from '../client/zendesk-api';

export type Bucket = 'incremental' | 'standard';
export interface ExportDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rateLimitWaitMs?: number;
  errorWaitMs?: number;
}
export const defaultDeps: ExportDeps = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
export const resolveRates = (
  rates: Partial<Record<Bucket, number>> = {},
): Record<Bucket, number> => {
  const resolved = { incremental: 10, standard: 300, ...rates };
  for (const rate of Object.values(resolved)) {
    if (!Number.isFinite(rate) || rate <= 0)
      throw new Error('Rates must be positive finite requests per minute');
  }
  return resolved;
};

const retryKind = (err: unknown): 'throttle' | 'error' | undefined => {
  if (err instanceof ZendeskApiError && err.status === 429) return 'throttle';
  if (isZendeskNetworkError(err) || (err instanceof ZendeskApiError && err.status >= 500))
    return 'error';
  return undefined;
};

/** Sequential reservations also pace concurrent callers in the same bucket. */
export const createPacedGet = (
  subdomain: string,
  getToken: () => string | Promise<string>,
  rates: Partial<Record<Bucket, number>> = {},
  deps: ExportDeps = defaultDeps,
  onRequest: () => void = () => undefined,
) => {
  const limits = resolveRates(rates);
  const next: Record<Bucket, number> = { incremental: 0, standard: 0 };
  const pace = async (bucket: Bucket) => {
    const at = Math.max(deps.now(), next[bucket]);
    next[bucket] = at + 60_000 / limits[bucket];
    const wait = at - deps.now();
    if (wait > 0) await deps.sleep(wait);
  };
  const delays = { throttle: deps.rateLimitWaitMs ?? 60_000, error: deps.errorWaitMs ?? 30_000 };
  const maximum = { throttle: 10, error: 5 };
  const pacedGet = async <T>(
    bucket: Bucket,
    path: string,
    params?: Record<string, string>,
  ): Promise<T> => {
    const retries = { throttle: 0, error: 0 };
    while (true) {
      const token = await getToken();
      await pace(bucket);
      onRequest();
      try {
        return await zendeskGet<T>(subdomain, token, path, params);
      } catch (err) {
        const kind = retryKind(err);
        if (!kind || retries[kind] >= maximum[kind]) throw err;
        retries[kind] += 1;
        await deps.sleep(delays[kind]);
      }
    }
  };
  return pacedGet;
};
