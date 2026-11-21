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
  /** What Zendesk's 403 response body said; see `zendeskErrorBody`. */
  zendesk_error?: ZendeskErrorBody;
  /** API path (under /api/v2, without the query) of the request that got the 403. */
  failed_path?: string;
  /** How to recover from a skip whose likely cause is known. */
  hint?: string;
  /** Side conversations whose lookup got 403/404; their events are still exported. */
  unreadable_conversations?: UnreadableConversation[];
  /** Side event start times skipped past a persistent server error; see `fetchPage`. */
  skipped_windows?: SkippedWindow[];
}
/**
 * The documented `error` / `description` strings of a Zendesk error body, or,
 * for a body without them (another JSON shape, an HTML page, nothing), a short
 * excerpt, empty for an empty body.
 */
export interface ZendeskErrorBody {
  error?: string;
  description?: string;
  body?: string;
}
export interface UnreadableConversation {
  ticket_id: number;
  side_conversation_id: string;
  status: number;
  zendesk_error: ZendeskErrorBody;
}
/**
 * Side events in `[from, to)` (epoch seconds) were not exported: a page starting
 * at `from` kept answering `status` (5xx), and `to` is the first start time that
 * answered again.
 */
export interface SkippedWindow {
  from: number;
  to: number;
  status: number;
}
interface RequestState {
  current: StreamState | undefined;
  /** Path of the latest request, so a failure can name it. */
  path?: string | undefined;
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
  /**
   * Most seconds of side events to skip past a page that keeps answering 5xx
   * before the stream fails; 0 never skips. Default 86,400 (24 h).
   */
  sideEventsMaxSkip?: number;
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
  validateMaxSkip(options.sideEventsMaxSkip);
};

export const DEFAULT_SIDE_EVENTS_MAX_SKIP = 86_400;
export const validateMaxSkip = (value: number | undefined): number => {
  const seconds = value ?? DEFAULT_SIDE_EVENTS_MAX_SKIP;
  if (!Number.isSafeInteger(seconds) || seconds < 0)
    throw new Error('The side event skip limit must be a nonnegative number of seconds');
  return seconds;
};

// An optional manifest list (unreadable conversations, skipped windows) must be
// a list of records, or resume would trip over it mid-stream.
const optionalRecords = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) &&
    value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)));

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
    if (!optionalRecords(state.unreadable_conversations))
      throw new Error('Invalid unreadable conversations checkpoint');
    if (!optionalRecords(state.skipped_windows))
      throw new Error('Invalid skipped windows checkpoint');
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
  const requestState: RequestState = { current: undefined };
  const get = createPacedGet(options.subdomain, options.getToken, rates, deps, (path) => {
    requestState.path = path;
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

// Step sizes, in seconds, of the probes past a failing side event page: doubling
// from 1 s so a short failure costs little data, capped so a long one does not
// leap a day at once.
const SKIP_STEP_CAP = 3600;
// Zendesk asks incremental exports to start more than a minute in the past.
const INCREMENTAL_LAG = 60;

const isServerError = (err: unknown): err is ZendeskApiError =>
  err instanceof ZendeskApiError && err.status >= 500;

/**
 * Fetch a page; for side events, survive a start time Zendesk keeps answering
 * with a 5xx after every retry (seen in production on one page, across runs).
 * Probe later start times, 1 s on and then in doubling steps up to an hour, and
 * resume from the first that answers, reporting the skipped window. Give up with
 * the original error once the window would pass the skip limit or reach the
 * last minute.
 */
const fetchPage = async (
  name: DataStream,
  state: StreamState,
  request: ApiRequest,
  get: ReturnType<typeof createPacedGet>,
  options: DataExportOptions,
): Promise<{ body: Body; request: ApiRequest; skipped?: SkippedWindow }> => {
  try {
    return { body: await getPage(name, state, request, get, options.subdomain), request };
  } catch (err) {
    if (name !== 'side_conversation_events' || !isServerError(err)) throw err;
    const from = Number(request.params['start_time']);
    const limit = from + validateMaxSkip(options.sideEventsMaxSkip);
    const latest = Math.floor((options.deps ?? defaultDeps).now() / 1000) - INCREMENTAL_LAG;
    let step = 1;
    for (let to = from + step; to <= limit && to <= latest; to += step) {
      const probe = { path: request.path, params: { ...request.params, start_time: String(to) } };
      try {
        const body = await getPage(name, state, probe, get, options.subdomain);
        return { body, request: probe, skipped: { from, to, status: err.status } };
      } catch (probeError) {
        if (!isServerError(probeError)) throw probeError;
      }
      step = Math.min(step * 2, SKIP_STEP_CAP);
    }
    throw err;
  }
};

// Do not publish new offsets until every file in this page has been flushed.
// What the page noted on the side is committed with it: an uncommitted page is
// retried, its conversation lookups and skip probes included.
const commitPage = async (
  snapshot: string,
  state: StreamState,
  page: {
    files: Record<string, unknown[]>;
    unreadable: UnreadableConversation[];
    skipped?: SkippedWindow | undefined;
  },
): Promise<void> => {
  const updated = { ...state.files };
  for (const [file, values] of Object.entries(page.files))
    updated[file] = await appendPage(snapshot, file, values, state.files[file]);
  state.files = updated;
  if (page.unreadable.length)
    state.unreadable_conversations = [
      ...(state.unreadable_conversations ?? []),
      ...page.unreadable,
    ];
  if (page.skipped) state.skipped_windows = [...(state.skipped_windows ?? []), page.skipped];
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
  const conversations = await knownConversations(name, snapshot, state);
  while (state.position.request) {
    const fetched = await fetchPage(name, state, state.position.request, get, options);
    const { body, request: current } = fetched;
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
    const output = await pageOutput(name, body, items, conversations, get);
    await commitPage(snapshot, state, { ...output, skipped: fetched.skipped });
    state.position = { request: next, previous_ids: ids };
    state.pages += 1;
    state.duration_ms = (options.deps ?? defaultDeps).now() - Date.parse(state.started_at);
    await checkpoint();
  }
  // The final page's null position is itself a checkpoint, even before status changes.
};

const conversationKey = (ticket: unknown, conversation: unknown): string =>
  JSON.stringify([ticket, conversation]);

// Conversations a resumed side-event stream must not look up again: those
// written to the snapshot and those recorded as unreadable.
const knownConversations = async (
  name: DataStream,
  snapshot: string,
  state: StreamState,
): Promise<Set<string>> => {
  if (name !== 'side_conversation_events') return new Set<string>();
  const seen = await readConversationKeys(snapshot, state.files['side_conversations.ndjson']);
  for (const entry of state.unreadable_conversations ?? [])
    seen.add(conversationKey(entry.ticket_id, entry.side_conversation_id));
  return seen;
};

// A page's NDJSON rows per file, plus, for side events, the referenced
// conversations it read and those it could not.
const pageOutput = async (
  name: DataStream,
  body: Body,
  items: Body[],
  seen: Set<string>,
  get: ReturnType<typeof createPacedGet>,
): Promise<{ files: Record<string, unknown[]>; unreadable: UnreadableConversation[] }> => {
  const files = pageFiles(name, body, items);
  if (name !== 'side_conversation_events') return { files, unreadable: [] };
  const { conversations, unreadable } = await conversationRows(items, seen, get);
  return { files: { ...files, 'side_conversations.ndjson': conversations }, unreadable };
};

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

// One unreadable conversation (403/404: say, on a deleted ticket) must not cost
// the stream: its events are kept and the lookup is recorded instead.
const readConversation = async (
  get: ReturnType<typeof createPacedGet>,
  ticket: number,
  id: string,
): Promise<{ body: Body } | { unreadable: UnreadableConversation }> => {
  try {
    return {
      body: await get<Body>(
        'standard',
        `/tickets/${ticket}/side_conversations/${encodeURIComponent(id)}`,
      ),
    };
  } catch (err) {
    if (!(err instanceof ZendeskApiError && (err.status === 403 || err.status === 404))) throw err;
    return {
      unreadable: {
        ticket_id: ticket,
        side_conversation_id: id,
        status: err.status,
        zendesk_error: zendeskErrorBody(err.body),
      },
    };
  }
};

const conversationRows = async (
  items: Body[],
  seen: Set<string>,
  get: ReturnType<typeof createPacedGet>,
): Promise<{ conversations: Body[]; unreadable: UnreadableConversation[] }> => {
  const conversations: Body[] = [];
  const unreadable: UnreadableConversation[] = [];
  for (const event of items) {
    const ticket = event['ticket_id'];
    const id = event['side_conversation_id'];
    if (!Number.isSafeInteger(ticket) || (ticket as number) <= 0 || !validObjectKey(id))
      throw new Error('Missing ticket_id or side_conversation_id on side conversation event');
    const key = conversationKey(ticket, id);
    if (seen.has(key)) continue;
    const read = await readConversation(get, ticket as number, id);
    if ('unreadable' in read) {
      unreadable.push(read.unreadable);
      seen.add(key);
      continue;
    }
    const conversation = read.body['side_conversation'];
    if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation))
      throw new Error('Expected side_conversation to be an object');
    conversations.push({ ...conversation, ticket_id: ticket });
    seen.add(key);
  }
  return { conversations, unreadable };
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

const BODY_EXCERPT_MAX = 500;
const WHITESPACE_RUN = /\s+/g;

// Only the response body is kept: never the request, its headers or the token.
export const zendeskErrorBody = (body: string): ZendeskErrorBody => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const fields = (parsed ?? {}) as Record<string, unknown>;
  const summary: ZendeskErrorBody = {};
  if (typeof fields['error'] === 'string') summary.error = fields['error'];
  if (typeof fields['description'] === 'string') summary.description = fields['description'];
  if (summary.error !== undefined || summary.description !== undefined) return summary;
  return { body: body.replace(WHITESPACE_RUN, ' ').trim().slice(0, BODY_EXCERPT_MAX) };
};

// Side conversations sit outside the global `read` scope, and tokens signed in
// before the server asked for `side_conversations:read` do not hold it.
const sideConversationsHint = (subdomain: string): string =>
  'The OAuth token may lack the side_conversations:read scope (sign-ins before it was ' +
  `requested hold only read). Re-authorize with "zendesk-mcp-server login ${subdomain} ` +
  '--read-only" (without --read-only for a read-write server), then export ' +
  'side_conversation_events again.';

const recordFailure = async (
  name: DataStream,
  err: unknown,
  state: StreamState,
  options: DataExportOptions,
  failedPath: string | undefined,
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
  // Whichever request got the 403 (the first page or a later one), say what
  // Zendesk answered and where.
  if (err.status === 403) {
    state.zendesk_error = zendeskErrorBody(err.body);
    if (failedPath !== undefined) state.failed_path = failedPath;
    if (name === 'side_conversation_events') state.hint = sideConversationsHint(options.subdomain);
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
  requestState: RequestState,
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
    requestState.path = undefined;
    if (state.status === 'pending') state.started_at = new Date(deps.now()).toISOString();
    state.status = 'running';
    delete state.reason;
    delete state.zendesk_error;
    delete state.failed_path;
    delete state.hint;
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
      await recordFailure(name, err, state, options, requestState.path, get, checkpoint);
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
