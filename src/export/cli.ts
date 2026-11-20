import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { buildBasicAuthHeader } from '../auth/api-token';
import { createTokenStore, isAuthRequiredError } from '../auth/token-store';
import { LogLevel, loadConfig } from '../config';
import { createLogger } from '../utils/logger';
import { DATA_STREAMS, type DataStream, parseSince, runDataExport } from './data-export';
import { GOLDEN_STAGES, type GoldenStage, runGoldens } from './goldens';
import { validateResumeName } from './ndjson';
import { defaultDeps, type ExportDeps, resolveRates } from './rate-limit';

const USAGE =
  'Usage: zendesk-mcp-server export-data <subdomain> --export-dir <absolute-local-path> [--since <ISO|epoch>] [--only <stream>]... [--resume <folder>] [--rate <requests/min>] [--log-level <debug|info|warn|error>]';
const GOLDENS_USAGE =
  'Usage: zendesk-mcp-server record-goldens <subdomain> --export-dir <absolute-local-path> --data-snapshot <folder-name> [--only <stage>]... [--view-row-cap <rows>] [--macro-sample <tickets>] [--sla-sample <tickets>] [--queries <absolute-json-path>] [--resume <folder>] [--rate <requests/min>] [--log-level <debug|info|warn|error>]';
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]*$/i;
const NETWORK_PATH = /^[\\/]{2}/;
const parseStrictOptions = (args: string[], goldens = false) => {
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        'export-dir': { type: 'string' },
        'data-snapshot': { type: 'string' },
        'view-row-cap': { type: 'string' },
        'macro-sample': { type: 'string' },
        'sla-sample': { type: 'string' },
        queries: { type: 'string' },
        since: { type: 'string' },
        only: { type: 'string', multiple: true },
        resume: { type: 'string' },
        rate: { type: 'string' },
        'log-level': { type: 'string' },
      },
    });
    const goldenFlags = ['data-snapshot', 'view-row-cap', 'macro-sample', 'sla-sample', 'queries'];
    if (
      Object.keys(parsed.values).some((key) =>
        goldens ? key === 'since' : goldenFlags.includes(key),
      )
    )
      throw new Error('Unsupported flag');
    return parsed;
  } catch (err) {
    throw new Error(goldens ? GOLDENS_USAGE : USAGE, { cause: err });
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

export const parseGoldensArgs = (args: string[]) => {
  const { values, positionals } = parseStrictOptions(args, true);
  const shared = parseExportArgs([
    ...positionals,
    '--export-dir',
    values['export-dir'] ?? '',
    '--rate',
    values.rate ?? '300',
    '--log-level',
    values['log-level'] ?? 'info',
    ...(values.resume !== undefined ? ['--resume', values.resume] : []),
  ]);
  if (!values['data-snapshot'])
    throw new Error('record-goldens requires --data-snapshot <folder name>');
  validateResumeName(values['data-snapshot']);
  if (values.only?.some((name) => !GOLDEN_STAGES.includes(name as GoldenStage)))
    throw new Error('Unknown golden stage');
  const numberFlag = (value: string) => {
    const parsed = Number(value);
    if (!value.trim() || !Number.isSafeInteger(parsed) || parsed < 0)
      throw new Error('Sample sizes and row caps must be nonnegative integers');
    return parsed;
  };
  const queries = values.queries;
  if (queries !== undefined && (!isAbsolute(queries) || NETWORK_PATH.test(queries)))
    throw new Error('Queries must be an absolute local JSON file');
  return {
    ...shared,
    dataSnapshot: values['data-snapshot'],
    ...(values.only ? { stages: values.only as GoldenStage[] } : {}),
    options: {
      ...(values['view-row-cap'] !== undefined
        ? { viewRowCap: numberFlag(values['view-row-cap']) }
        : {}),
      ...(values['macro-sample'] !== undefined
        ? { macroSample: numberFlag(values['macro-sample']) }
        : {}),
      ...(values['sla-sample'] !== undefined
        ? { slaSample: numberFlag(values['sla-sample']) }
        : {}),
      ...(queries !== undefined ? { queries } : {}),
    },
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

const runCli = async (args: string[], goldens: boolean): Promise<number> => {
  // Complete pure argument validation before creating auth state or doing I/O.
  const goldenOptions = goldens ? parseGoldensArgs(args) : undefined;
  const options = goldenOptions ?? parseExportArgs(args);
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
    const auth = {
      getToken: () => waitForExportToken(tokenSource.getToken, (line) => console.error(line)),
    };
    if (goldenOptions) {
      const result = await runGoldens({
        ...goldenOptions,
        ...auth,
        onProgress: (manifest) => {
          const progress = Object.entries(manifest.stages)
            .map(([name, state]) => `${name}: ${state.status}, ${state.items} items`)
            .join('; ');
          logger.info('goldens_progress', { progress });
        },
      });
      console.log(
        JSON.stringify({
          snapshot: result.snapshot,
          stages: result.manifest.stages,
          duration_ms: result.duration_ms,
        }),
      );
      return Object.values(result.manifest.stages).some((stage) => stage.status === 'failed')
        ? 1
        : 0;
    }
    const result = await runDataExport({
      ...options,
      ...auth,
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

export const runExportCli = (args: string[]) => runCli(args, false);
export const runGoldensCli = (args: string[]) => runCli(args, true);
