import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { buildBasicAuthHeader } from '../auth/api-token';
import { createTokenStore, isAuthRequiredError } from '../auth/token-store';
import { LogLevel, loadConfig } from '../config';
import { createLogger } from '../utils/logger';
import { DATA_STREAMS, type DataStream, parseSince, runDataExport } from './data-export';
import { validateResumeName } from './ndjson';
import { defaultDeps, type ExportDeps, resolveRates } from './rate-limit';

const USAGE =
  'Usage: zendesk-mcp-server export-data <subdomain> --export-dir <absolute-local-path> [--since <ISO|epoch>] [--only <stream>]... [--resume <folder>] [--rate <requests/min>] [--log-level <debug|info|warn|error>]';
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]*$/i;
const NETWORK_PATH = /^[\\/]{2}/;
const parseStrictOptions = (args: string[]) => {
  try {
    return parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        'export-dir': { type: 'string' },
        since: { type: 'string' },
        only: { type: 'string', multiple: true },
        resume: { type: 'string' },
        rate: { type: 'string' },
        'log-level': { type: 'string' },
      },
    });
  } catch (err) {
    throw new Error(USAGE, { cause: err });
  }
};

export const parseExportArgs = (args: string[]) => {
  const { values, positionals } = parseStrictOptions(args);
  const [subdomain] = positionals;
  const exportDir = values['export-dir'];
  if (
    positionals.length !== 1 ||
    !subdomain ||
    !SUBDOMAIN.test(subdomain) ||
    !exportDir ||
    !isAbsolute(exportDir) ||
    NETWORK_PATH.test(exportDir)
  )
    throw new Error(USAGE);
  if (values.only?.some((name) => !DATA_STREAMS.includes(name as DataStream)))
    throw new Error(`Unknown stream. ${USAGE}`);
  const standard = values.rate === undefined ? 300 : Number(values.rate);
  resolveRates({ standard });
  if (values.since !== undefined) parseSince(values.since);
  if (values.resume !== undefined) validateResumeName(values.resume);
  const logLevel = LogLevel.parse(values['log-level'] ?? 'info');
  return {
    subdomain,
    exportDir,
    ...(values.since !== undefined ? { since: values.since } : {}),
    ...(values.only ? { streams: values.only as DataStream[] } : {}),
    ...(values.resume !== undefined ? { resume: values.resume } : {}),
    rates: { standard },
    logLevel,
  };
};

export const waitForExportToken = async (
  getToken: () => string | Promise<string>,
  stderr: (message: string) => void,
  deps: ExportDeps = defaultDeps,
): Promise<string> => {
  const deadline = deps.now() + 10 * 60_000;
  let shown: string | undefined;
  while (true) {
    try {
      return await getToken();
    } catch (err) {
      if (!isAuthRequiredError(err)) throw err;
      if (shown !== err.authorizeUrl) {
        stderr(`Authorize read-only export: ${err.authorizeUrl}`);
        shown = err.authorizeUrl;
      }
      if (deps.now() >= deadline)
        throw new Error('Timed out waiting for Zendesk authorization', { cause: err });
      await deps.sleep(3000);
    }
  }
};

export const runExportCli = async (args: string[]): Promise<number> => {
  // Complete pure argument validation before creating auth state or doing I/O.
  const options = parseExportArgs(args);
  const config = loadConfig([
    options.subdomain,
    '--export-dir',
    options.exportDir,
    '--read-only',
    '--log-level',
    options.logLevel,
  ]);
  const logger = createLogger(config.logLevel);
  const tokenSource =
    config.zendeskEmail && config.zendeskApiToken
      ? {
          getToken: () =>
            buildBasicAuthHeader(config.zendeskEmail ?? '', config.zendeskApiToken ?? ''),
          dispose: () => undefined,
        }
      : createTokenStore(
          {
            subdomain: config.subdomain,
            oauthClientId: config.oauthClientId,
            callbackPort: config.callbackPort,
            readOnly: true,
          },
          logger,
        );
  try {
    const result = await runDataExport({
      ...options,
      getToken: () => waitForExportToken(tokenSource.getToken, (line) => console.error(line)),
      onProgress: (manifest) => {
        const progress = Object.entries(manifest.streams)
          .map(([name, state]) => `${name}: ${state.status}, ${state.pages} pages`)
          .join('; ');
        logger.info('export_progress', { progress });
      },
    });
    console.log(
      JSON.stringify({
        snapshot: result.snapshot,
        streams: result.manifest.streams,
        duration_ms: result.duration_ms,
      }),
    );
    return Object.values(result.manifest.streams).some((stream) => stream.status === 'failed')
      ? 1
      : 0;
  } finally {
    tokenSource.dispose();
  }
};
