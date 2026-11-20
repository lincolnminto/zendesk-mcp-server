import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ZendeskApiError, type zendeskGet } from '../client/zendesk-api';
import type { ToolContext } from '../tools/definitions';
import {
  type ApiRequest,
  firstPage,
  type ManifestEntry,
  nextRequest,
  RESOURCE_KEYS,
  runConfigExport,
  skipReason,
  snapshotDirName,
} from './account-config';
import {
  appendPage,
  type FileStats,
  readFileStats,
  readManifest,
  safeDirectory,
  truncateFiles,
  validateResumeName,
  writeManifest,
} from './ndjson';
import {
  type Bucket,
  createPacedGet,
  defaultDeps,
  type ExportDeps,
  resolveRates,
} from './rate-limit';

export const DATA_STREAMS = [
  'tickets',
  'users',
  'organizations',
  'ticket_events',
  'ticket_metric_events',
  'side_conversation_events',
  'groups',
  'group_memberships',
  'organization_memberships',
  'satisfaction_ratings',
  'custom_object_records',
  'config',
] as const;
export type DataStream = (typeof DATA_STREAMS)[number];
type Body = Record<string, unknown>;
interface Position {
  request: ApiRequest | null;
  previous_ids: Array<string | number>;
  custom_objects?: { keys: string[]; next_list: ApiRequest | null };
}
export interface StreamState {
  status: 'pending' | 'running' | 'exported' | 'skipped' | 'failed';
  files: Record<string, FileStats>;
  requests: number;
  pages: number;
  position: Position;
  include_used?: string | null | undefined;
  started_at: string;
  finished_at?: string;
  duration_ms: number;
  reason?: string;
}
export interface DataManifest {
  subdomain: string;
  kind: 'data';
  started_at: string;
  finished_at?: string;
  since: number;
  rates: Record<Bucket, number>;
  current_user: { id: number; role: string };
  streams: Partial<Record<DataStream, StreamState>>;
}
export interface DataExportOptions {
  subdomain: string;
  getToken: ToolContext['getToken'];
  exportDir: string;
  since?: string | number;
  streams?: DataStream[];
  resume?: string;
  rates?: Partial<Record<Bucket, number>>;
  deps?: ExportDeps;
  onProgress?: (manifest: DataManifest, snapshot: string) => void;
}
const EPOCH = /^\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/;
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]*$/i;
const NETWORK_PATH = /^[\\/]{2}/;
const JSON_SUFFIX = /\.json$/;
export const parseSince = (value: string | number | undefined): number => {
  if (value === undefined) return 0;
  let seconds: number;
  if (typeof value === 'number' || EPOCH.test(value)) seconds = Number(value);
  else seconds = ISO_DATE.test(value) ? Date.parse(value) / 1000 : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 8_640_000_000_000)
    throw new Error('Since must be an ISO date or non-negative epoch seconds');
  return seconds;
};
const incremental = (name: DataStream): boolean => DATA_STREAMS.indexOf(name) < 6;
const timeBased = (name: DataStream): boolean =>
  incremental(name) && name !== 'tickets' && name !== 'users';
const streamPath = (name: DataStream): string => {
  if (name === 'side_conversation_events') return '/tickets/side_conversations/events';
  if (name === 'custom_object_records') return '/custom_objects';
  if (name === 'tickets' || name === 'users') return `/incremental/${name}/cursor`;
  return incremental(name) ? `/incremental/${name}` : `/${name}`;
};
const supportScope = (name: DataStream): Record<string, string> =>
  name === 'tickets' || name === 'ticket_events' ? { support_type_scope: 'all' } : {};
const initialRequest = (name: DataStream, since: number): ApiRequest => ({
  path: streamPath(name),
  params: incremental(name)
    ? { start_time: String(since), ...incrementalPageSize(name), ...supportScope(name) }
    : cursorPageSize(streamPath(name)),
});
const incrementalPageSize = (name: DataStream): Record<string, string> =>
  name === 'side_conversation_events' ? {} : { per_page: '1000' };
const defaultInclude = (name: DataStream): string | undefined => {
  if (name === 'tickets') return 'metric_sets,dates,slas';
  if (name === 'users') return 'identities';
  if (name === 'ticket_events') return 'comment_events';
  return undefined;
};
const streamFiles = (name: DataStream): string[] => {
  const files = [`${name}.ndjson`];
  if (name === 'tickets') files.push('ticket_metrics.ndjson', 'ticket_slas.ndjson');
  if (name === 'users') files.push('user_identities.ndjson');
  if (name === 'ticket_events') files.push('comments.ndjson', 'attachments.ndjson');
  if (name === 'side_conversation_events') files.push('side_conversations.ndjson');
  return files;
};
const allowedFiles = (name: DataStream): string[] =>
  name === 'config'
    ? RESOURCE_KEYS.map((resource) => `config/${resource}.json`)
    : streamFiles(name);

const rows = (body: Body, key: string): Body[] => {
  const value = body[key];
  if (
    !Array.isArray(value) ||
    value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
  )
    throw new Error(`Expected ${key} to be an array of objects`);
  return value as Body[];
};
const optionalRows = (body: Body, key: string): Body[] =>
  body[key] === undefined ? [] : rows(body, key);

const commentFiles = (items: Body[]): Record<string, Body[]> => {
  const comments: Body[] = [];
  const attachments: Body[] = [];
  for (const event of items) {
    for (const child of optionalRows(event, 'child_events')) {
      if (child['event_type'] !== 'Comment' && child['type'] !== 'Comment') continue;
      comments.push({
        ticket_id: event['ticket_id'],
        ticket_event_id: event['id'],
        timestamp: event['timestamp'],
        ...child,
      });
      for (const attachment of optionalRows(child, 'attachments'))
        attachments.push({
          ticket_id: event['ticket_id'],
          comment_id: child['id'],
          ...attachment,
        });
    }
  }
  return { 'comments.ndjson': comments, 'attachments.ndjson': attachments };
};

const pageFiles = (name: DataStream, body: Body, items: Body[]): Record<string, unknown[]> => {
  const files: Record<string, unknown[]> = { [`${name}.ndjson`]: items };
  if (name === 'tickets') {
    files['ticket_metrics.ndjson'] = optionalRows(body, 'metric_sets');
    // TODO: Confirm the SLA sideload schema on a tenant; preserve any returned shape raw.
    const slas = body['slas'];
    if (slas !== undefined && slas !== null) {
      const values = Array.isArray(slas) ? slas : [slas];
      if (values.length) files['ticket_slas.ndjson'] = values;
    }
  }
  if (name === 'users') {
    const identities = optionalRows(body, 'identities');
    if (identities.length) files['user_identities.ndjson'] = identities;
  }
  if (name === 'ticket_events') Object.assign(files, commentFiles(items));
  return files;
};

const nextPosition = (
  name: DataStream,
  body: Body,
  current: ApiRequest,
  subdomain: string,
): ApiRequest | null => {
  if (!incremental(name)) return nextRequest(body, subdomain) ?? null;
  if (body['end_of_stream'] === true) return null;
  if (name === 'tickets' || name === 'users') {
    const cursor = body['after_cursor'];
    if (typeof cursor !== 'string' || !cursor || cursor === current.params['cursor'])
      throw new Error('Missing or repeated incremental cursor');
    return { path: streamPath(name), params: { cursor, per_page: '1000', ...supportScope(name) } };
  }
  // Metric events may omit end_of_stream and always return a polling link.
  if (
    name === 'ticket_metric_events' &&
    body['end_of_stream'] === undefined &&
    rows(body, responseKey(name)).length < 1000
  )
    return null;
  if (name === 'side_conversation_events' && body['next_page'] === null) return null;
  const next = nextRequest(body, subdomain);
  if (next) return { ...next, params: { ...next.params, ...supportScope(name) } };
  if (typeof body['end_time'] !== 'number')
    throw new Error('Missing end_time on an unfinished incremental page');
  return {
    path: streamPath(name),
    params: {
      start_time: String(body['end_time']),
      ...incrementalPageSize(name),
      ...supportScope(name),
    },
  };
};
const responseKey = (name: DataStream): string =>
  name === 'side_conversation_events' ? 'events' : name;

const recordPath = (key: string): string => `/custom_objects/${encodeURIComponent(key)}/records`;
// List Custom Objects (GET /custom_objects) is not paginated and rejects page[size] with a 400
// ("page must be an integer"); its records and every other list take cursor pagination.
const cursorPageSize = (path: string): Record<string, string> =>
  samePath(path, '/custom_objects') ? {} : { 'page[size]': '100' };
const samePath = (path: string, expected: string): boolean =>
  path === expected || path === `${expected}.json`;
const validRequest = (request: ApiRequest, paths: string[]): boolean =>
  paths.some((path) => samePath(request.path, path)) &&
  Boolean(request.params) &&
  Object.values(request.params).every((value) => typeof value === 'string');
const validObjectKey = (key: unknown): key is string =>
  typeof key === 'string' && key.length > 0 && key !== '.' && key !== '..';

const validatePosition = (name: DataStream, position: Position): void => {
  const paths = [streamPath(name)];
  const objects = position.custom_objects;
  if (objects !== undefined) {
    if (
      name !== 'custom_object_records' ||
      !objects ||
      !Array.isArray(objects.keys) ||
      !objects.keys.every(validObjectKey) ||
      (objects.next_list !== null && !validRequest(objects.next_list, ['/custom_objects']))
    )
      throw new Error('Invalid custom object checkpoint');
    if (objects.keys[0]) paths.push(recordPath(objects.keys[0]));
  }
  if (position.request && !validRequest(position.request, paths))
    throw new Error('Invalid resume request');
};

const validateOptions = (options: DataExportOptions): void => {
  if (!SUBDOMAIN.test(options.subdomain)) throw new Error('Invalid Zendesk subdomain');
  if (!isAbsolute(options.exportDir) || NETWORK_PATH.test(options.exportDir))
    throw new Error('Export directory must be an absolute local path');
  if (options.resume !== undefined) validateResumeName(options.resume);
  if (
    options.streams &&
    (!options.streams.length || options.streams.some((name) => !DATA_STREAMS.includes(name)))
  )
    throw new Error('Select one or more supported streams');
  resolveRates(options.rates);
  parseSince(options.since);
};

const validateManifest = (manifest: DataManifest, options: DataExportOptions): void => {
  if (
    manifest.kind !== 'data' ||
    manifest.subdomain !== options.subdomain ||
    !manifest.streams ||
    typeof manifest.streams !== 'object'
  )
    throw new Error('Resume manifest does not belong to this account data export');
  parseSince(manifest.since);
  resolveRates(manifest.rates);
  if (options.since !== undefined && parseSince(options.since) !== manifest.since)
    throw new Error('Since cannot change when resuming');
  for (const [name, state] of Object.entries(manifest.streams)) {
    if (
      !DATA_STREAMS.includes(name as DataStream) ||
      !state?.files ||
      !state.position ||
      !Array.isArray(state.position.previous_ids)
    )
      throw new Error('Invalid stream checkpoint');
    validatePosition(name as DataStream, state.position);
    if (Object.keys(state.files).some((file) => !allowedFiles(name as DataStream).includes(file)))
      throw new Error('Invalid checkpoint filename');
  }
};

/** Reserve the folder before a background job returns to its MCP caller. */
export const prepareDataExport = async (options: DataExportOptions) => {
  validateOptions(options);
  const deps = options.deps ?? defaultDeps;
  const since = parseSince(options.since);
  await options.getToken();
  const root = resolve(options.exportDir);
  await safeDirectory(root, true);
  let manifest: DataManifest | undefined;
  let snapshot = '';
  if (options.resume !== undefined) {
    snapshot = join(root, validateResumeName(options.resume));
    await safeDirectory(snapshot, false);
    manifest = await readManifest<DataManifest>(snapshot);
    validateManifest(manifest, options);
    if (options.streams?.some((name) => !manifest?.streams[name]))
      throw new Error('Resume streams must exist in the original snapshot');
  }
  const rates = resolveRates({ ...manifest?.rates, ...options.rates });
  const requestState: { current: StreamState | undefined } = { current: undefined };
  const get = createPacedGet(options.subdomain, options.getToken, rates, deps, () => {
    if (requestState.current) requestState.current.requests += 1;
  });
  const me = await get<{ user: { id: number; role: string } }>('standard', '/users/me');
  if (!manifest) {
    const at = new Date(deps.now());
    snapshot = join(root, snapshotDirName(`${options.subdomain}-data`, at));
    await mkdir(snapshot, { mode: 0o700 });
    const selected = DATA_STREAMS.filter((name) => options.streams?.includes(name) ?? true);
    manifest = {
      subdomain: options.subdomain,
      kind: 'data',
      started_at: at.toISOString(),
      since,
      rates,
      current_user: { id: me.user.id, role: me.user.role },
      streams: {},
    };
    for (const name of selected)
      manifest.streams[name] = {
        status: 'pending',
        files: {},
        requests: 0,
        pages: 0,
        position: { request: initialRequest(name, since), previous_ids: [] },
        started_at: at.toISOString(),
        duration_ms: 0,
        ...(defaultInclude(name) !== undefined ? { include_used: defaultInclude(name) } : {}),
      };
  }
  manifest.current_user = { id: me.user.id, role: me.user.role };
  manifest.rates = rates;
  delete manifest.finished_at;
  await writeManifest(snapshot, manifest);
  const preparedManifest = manifest;
  return {
    snapshot,
    manifest,
    run: () => executeExport(options, snapshot, preparedManifest, deps, get, requestState),
  };
};

const getPage = async (
  name: DataStream,
  state: StreamState,
  request: ApiRequest,
  get: ReturnType<typeof createPacedGet>,
  subdomain: string,
): Promise<Body> => {
  const params = {
    ...request.params,
    ...supportScope(name),
    ...(state.include_used ? { include: state.include_used } : {}),
  };
  try {
    if (!incremental(name) && state.pages === 0) {
      const adapter: typeof zendeskGet = (_subdomain, _token, path, query) =>
        get('standard', path, query);
      return await firstPage(subdomain, '', request.path, adapter);
    }
    return await get(incremental(name) ? 'incremental' : 'standard', request.path, params);
  } catch (err) {
    if (
      !(
        err instanceof ZendeskApiError &&
        err.status === 400 &&
        state.include_used &&
        (name === 'tickets' || name === 'users')
      )
    )
      throw err;
    state.include_used =
      name === 'tickets' && state.include_used !== 'metric_sets' ? 'metric_sets' : null;
    return getPage(name, state, request, get, subdomain);
  }
};

const exportPages = async (
  name: DataStream,
  state: StreamState,
  snapshot: string,
  options: DataExportOptions,
  get: ReturnType<typeof createPacedGet>,
  checkpoint: () => Promise<void>,
): Promise<void> => {
  const recorded = Object.fromEntries(
    streamFiles(name).map((file) => [file, state.files[file] ?? { lines: 0, bytes: 0 }]),
  );
  await truncateFiles(snapshot, recorded);
  const conversations =
    name === 'side_conversation_events'
      ? await readConversationKeys(snapshot, state.files['side_conversations.ndjson'])
      : new Set<string>();
  while (state.position.request) {
    const current = state.position.request;
    const body = await getPage(name, state, current, get, options.subdomain);
    const raw = rows(body, responseKey(name));
    const previous = new Set(state.position.previous_ids);
    // Only time-based pages overlap at their boundary timestamp. A cursor stream
    // can legitimately return a newer version of a record from the previous page,
    // and dropping it would leave the stale one as the last line for that id.
    const items = timeBased(name)
      ? raw.filter((item) => !previous.has(item['id'] as string | number))
      : raw;
    let next = nextPosition(name, body, current, options.subdomain);
    // Side events expose a polling link without a documented terminal page size.
    // The last polling page repeats its boundary events and start_time.
    if (
      name === 'side_conversation_events' &&
      body['end_of_stream'] === undefined &&
      items.length === 0 &&
      next?.params['start_time'] === current.params['start_time']
    )
      next = null;
    const ids = raw
      .map((item) => item['id'])
      .filter((id): id is string | number => typeof id === 'number' || typeof id === 'string');
    if (next && JSON.stringify(next) === JSON.stringify(current) && items.length === 0)
      throw new Error('Incremental pagination made no progress');
    const files = pageFiles(name, body, items);
    if (name === 'side_conversation_events')
      files['side_conversations.ndjson'] = await conversationRows(items, conversations, get);
    // Do not publish new offsets until every file in this page has been flushed.
    const updated = { ...state.files };
    for (const [file, values] of Object.entries(files))
      updated[file] = await appendPage(snapshot, file, values, state.files[file]);
    state.files = updated;
    state.position = { request: next, previous_ids: ids };
    state.pages += 1;
    state.duration_ms = (options.deps ?? defaultDeps).now() - Date.parse(state.started_at);
    await checkpoint();
  }
  // The final page's null position is itself a checkpoint, even before status changes.
};

const conversationKey = (ticket: unknown, conversation: unknown): string =>
  JSON.stringify([ticket, conversation]);

/** Rebuild deduplication from committed rows after truncation, including on resume. */
const readConversationKeys = async (snapshot: string, stats?: FileStats): Promise<Set<string>> => {
  const seen = new Set<string>();
  if (!stats?.bytes) return seen;
  const handle = await open(
    join(snapshot, 'side_conversations.ndjson'),
    // biome-ignore lint/suspicious/noBitwiseOperators: Refuse symlink snapshot files.
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const input = createInterface({
      input: handle.createReadStream({ autoClose: false }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of input) {
      const row = JSON.parse(line) as Body;
      seen.add(conversationKey(row['ticket_id'], row['id']));
    }
  } finally {
    await handle.close();
  }
  return seen;
};

const conversationRows = async (
  items: Body[],
  seen: Set<string>,
  get: ReturnType<typeof createPacedGet>,
): Promise<Body[]> => {
  const conversations: Body[] = [];
  for (const event of items) {
    const ticket = event['ticket_id'];
    const id = event['side_conversation_id'];
    if (!Number.isSafeInteger(ticket) || (ticket as number) <= 0 || !validObjectKey(id))
      throw new Error('Missing ticket_id or side_conversation_id on side conversation event');
    const key = conversationKey(ticket, id);
    if (seen.has(key)) continue;
    const body = await get<Body>(
      'standard',
      `/tickets/${ticket}/side_conversations/${encodeURIComponent(id)}`,
    );
    const conversation = body['side_conversation'];
    if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation))
      throw new Error('Expected side_conversation to be an object');
    conversations.push({ ...conversation, ticket_id: ticket });
    seen.add(key);
  }
  return conversations;
};

const cursorNext = (body: Body, current: ApiRequest, subdomain: string): ApiRequest | null => {
  const meta = body['meta'] as { has_more?: boolean } | undefined;
  if (meta?.has_more === false) return null;
  const next = nextRequest(body, subdomain);
  if (!next) {
    if (meta?.has_more === true) throw new Error('Missing next custom object cursor');
    return null;
  }
  if (!samePath(next.path, current.path.replace(JSON_SUFFIX, '')))
    throw new Error('Invalid custom object pagination path');
  const request = { ...next, params: { ...next.params, ...cursorPageSize(next.path) } };
  if (JSON.stringify(request) === JSON.stringify(current))
    throw new Error('Custom object pagination made no progress');
  return request;
};

const objectRequest = (objects: NonNullable<Position['custom_objects']>): ApiRequest | null => {
  const key = objects.keys[0];
  return key ? { path: recordPath(key), params: { 'page[size]': '100' } } : objects.next_list;
};

const customObjectPage = (
  body: Body,
  position: Position,
  next: ApiRequest | null,
): { values: Body[]; position: Position } => {
  if (position.request && samePath(position.request.path, '/custom_objects')) {
    const keys = rows(body, 'custom_objects').map((object) => object['key']);
    if (!keys.every(validObjectKey)) throw new Error('Invalid custom object key');
    const objects = { keys, next_list: next };
    return {
      values: [],
      position: { request: objectRequest(objects), previous_ids: [], custom_objects: objects },
    };
  }
  const objects = position.custom_objects;
  const key = objects?.keys[0];
  if (!objects || !key) throw new Error('Missing custom object checkpoint key');
  const values = rows(body, 'custom_object_records').map((record) => ({
    ...record,
    custom_object_key: key,
  }));
  const remaining = next ? objects : { ...objects, keys: objects.keys.slice(1) };
  return {
    values,
    position: {
      request: next ?? objectRequest(remaining),
      previous_ids: [],
      custom_objects: remaining,
    },
  };
};

const exportCustomObjectRecords = async (
  state: StreamState,
  snapshot: string,
  options: DataExportOptions,
  get: ReturnType<typeof createPacedGet>,
  checkpoint: () => Promise<void>,
): Promise<void> => {
  const file = 'custom_object_records.ndjson';
  await truncateFiles(snapshot, { [file]: state.files[file] ?? { lines: 0, bytes: 0 } });
  while (state.position.request) {
    const current = state.position.request;
    const body = await get<Body>('standard', current.path, {
      ...current.params,
      ...cursorPageSize(current.path),
    });
    const next = cursorNext(body, current, options.subdomain);
    const { values, position } = customObjectPage(body, state.position, next);
    const stats = await appendPage(snapshot, file, values, state.files[file]);
    state.files = { ...state.files, [file]: stats };
    state.position = position;
    state.pages += 1;
    state.duration_ms = (options.deps ?? defaultDeps).now() - Date.parse(state.started_at);
    await checkpoint();
  }
};

const exportConfig = async (
  options: DataExportOptions,
  snapshot: string,
  state: StreamState,
  get: ReturnType<typeof createPacedGet>,
  checkpoint: () => Promise<void>,
): Promise<void> => {
  const folder = join(snapshot, 'config');
  await safeDirectory(folder, true);
  await truncateFiles(snapshot, state.files);
  let prior: ManifestEntry[] = [];
  try {
    const saved = await readManifest<{ resources: ManifestEntry[] }>(folder);
    prior = saved.resources.filter((entry) => entry.status !== 'failed');
    if (
      prior.some(
        (entry) =>
          !RESOURCE_KEYS.includes(entry.resource) ||
          (entry.status === 'exported' && entry.file !== `${entry.resource}.json`),
      )
    )
      throw new Error('Invalid configuration checkpoint');
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
  }
  const record = async (entry: ManifestEntry) => {
    if (entry.status === 'exported')
      state.files[`config/${entry.file}`] = await readFileStats(folder, entry.file);
  };
  for (const entry of prior) await record(entry);
  const selected = RESOURCE_KEYS.filter((name) => !prior.some((entry) => entry.resource === name));
  const request: typeof zendeskGet = (_subdomain, _token, path, params) =>
    get('standard', path, params);
  const entries = await runConfigExport(
    options,
    folder,
    selected,
    request,
    undefined,
    async (entry) => {
      await record(entry);
      state.pages += 1;
      await checkpoint();
    },
    prior,
  );
  const failed = entries.filter((entry) => entry.status === 'failed');
  if (failed.length)
    throw new Error(
      `Configuration resources failed: ${failed.map((entry) => entry.resource).join(', ')}`,
    );
  state.position.request = null;
};

const recordFailure = async (
  err: unknown,
  state: StreamState,
  get: ReturnType<typeof createPacedGet>,
  checkpoint: () => Promise<void>,
): Promise<void> => {
  state.status = 'failed';
  state.reason = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ZendeskApiError)) return;
  if (err.status === 403 || err.status === 404) {
    state.status = 'skipped';
    state.reason = skipReason(err);
  }
  if (err.status !== 401) return;
  try {
    await get('standard', '/users/me');
  } catch (meError) {
    if (meError instanceof ZendeskApiError && meError.status === 401) {
      await checkpoint();
      throw err;
    }
  }
};

const executeExport = async (
  options: DataExportOptions,
  snapshot: string,
  manifest: DataManifest,
  deps: ExportDeps,
  get: ReturnType<typeof createPacedGet>,
  requestState: { current: StreamState | undefined },
) => {
  const checkpoint = async () => {
    await writeManifest(snapshot, manifest);
    options.onProgress?.(manifest, snapshot);
  };
  for (const name of DATA_STREAMS) {
    const state = manifest.streams[name];
    if (
      !state ||
      (options.streams && !options.streams.includes(name)) ||
      state.status === 'exported' ||
      state.status === 'skipped'
    )
      continue;
    requestState.current = state;
    if (state.status === 'pending') state.started_at = new Date(deps.now()).toISOString();
    state.status = 'running';
    delete state.reason;
    delete state.finished_at;
    await checkpoint();
    try {
      if (name === 'config') await exportConfig(options, snapshot, state, get, checkpoint);
      else if (name === 'custom_object_records')
        await exportCustomObjectRecords(state, snapshot, options, get, checkpoint);
      else await exportPages(name, state, snapshot, options, get, checkpoint);
      state.status = 'exported';
    } catch (err) {
      state.finished_at = new Date(deps.now()).toISOString();
      state.duration_ms = deps.now() - Date.parse(state.started_at);
      await recordFailure(err, state, get, checkpoint);
    }
    state.finished_at = new Date(deps.now()).toISOString();
    state.duration_ms = deps.now() - Date.parse(state.started_at);
    await checkpoint();
  }
  manifest.finished_at = new Date(deps.now()).toISOString();
  await checkpoint();
  return { snapshot, manifest, duration_ms: deps.now() - Date.parse(manifest.started_at) };
};

export const runDataExport = async (options: DataExportOptions) =>
  (await prepareDataExport(options)).run();
