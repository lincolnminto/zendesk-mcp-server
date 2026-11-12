import { constants } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { ZendeskApiError, type zendeskGet } from '../client/zendesk-api';
import type { ToolContext } from '../tools/definitions';
import {
  type ApiRequest,
  firstPage,
  nextRequest,
  skipReason,
  snapshotDirName,
} from './account-config';
import {
  buildSearchQueries,
  macroKey,
  pick,
  type RecordRow,
  readLatestTickets,
  readRows,
  type SearchQuery,
  slaKey,
  slaSample,
  stratifiedSample,
} from './goldens-snapshot';
import {
  appendPage,
  type FileStats,
  readFileStats,
  readManifest,
  safeDirectory,
  snapshotFile,
  truncateFiles,
  validateResumeName,
  writeJsonFile,
  writeManifest,
} from './ndjson';
import {
  type Bucket,
  createPacedGet,
  defaultDeps,
  type ExportDeps,
  resolveRates,
} from './rate-limit';

export const GOLDEN_STAGES = ['context', 'views', 'macros', 'slas', 'search'] as const;
export type GoldenStage = (typeof GOLDEN_STAGES)[number];
type Body = Record<string, unknown>;
interface GoldenSettings {
  viewRowCap: number;
  macroSample: number;
  slaSample: number;
  queries?: string;
}
interface StageState {
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  requests: number;
  items: number;
  files: Record<string, FileStats>;
  started_at: string;
  finished_at?: string;
  duration_ms: number;
  reason?: string;
  sla_offset?: number;
  audit_offset?: number;
}
export interface GoldenManifest {
  subdomain: string;
  kind: 'goldens';
  data_snapshot: string;
  started_at: string;
  finished_at?: string;
  current_user: { id: number; role: string };
  options: GoldenSettings;
  stages: Partial<Record<GoldenStage, StageState>>;
}
export interface GoldensOptions {
  subdomain: string;
  getToken: ToolContext['getToken'];
  exportDir: string;
  dataSnapshot: string;
  stages?: GoldenStage[];
  options?: Partial<GoldenSettings>;
  resume?: string;
  rates?: Partial<Record<Bucket, number>>;
  deps?: ExportDeps;
  onProgress?: (manifest: GoldenManifest, snapshot: string) => void;
}
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]*$/i;
const NETWORK_PATH = /^[\\/]{2}/;
const TICKET_ID_KEY = /^\d+$/;
const ITEM_FILE = /^(views|macros)\/\d+\.json$/;
const FIXED_FILES = new Set([
  'context.json',
  'views/index.json',
  'macros/index.json',
  'macros/sample.json',
  'slas/sample.json',
  'slas.ndjson',
  'audits.ndjson',
  'search.json',
]);
const settingsFor = (options?: Partial<GoldenSettings>): GoldenSettings => {
  const settings = { viewRowCap: 2000, macroSample: 25, slaSample: 500, ...options };
  for (const key of ['viewRowCap', 'macroSample', 'slaSample'] as const)
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 0)
      throw new Error(`${key} must be a nonnegative integer`);
  if (
    settings.queries !== undefined &&
    (!isAbsolute(settings.queries) || NETWORK_PATH.test(settings.queries))
  )
    throw new Error('Queries must be an absolute local JSON file');
  return settings;
};
const validateOptions = (options: GoldensOptions) => {
  if (!SUBDOMAIN.test(options.subdomain)) throw new Error('Invalid Zendesk subdomain');
  if (!isAbsolute(options.exportDir) || NETWORK_PATH.test(options.exportDir))
    throw new Error('Export directory must be an absolute local path');
  validateResumeName(options.dataSnapshot);
  if (options.resume !== undefined) validateResumeName(options.resume);
  if (
    options.stages &&
    (!options.stages.length || options.stages.some((name) => !GOLDEN_STAGES.includes(name)))
  )
    throw new Error('Select one or more supported stages');
  settingsFor(options.options);
  resolveRates(options.rates);
};
const readJson = async <T>(path: string): Promise<T> => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Refuse symlink input files.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return JSON.parse(await handle.readFile('utf8')) as T;
  } finally {
    await handle.close();
  }
};
const missing = (err: unknown) => err instanceof Error && 'code' in err && err.code === 'ENOENT';
const readOptional = async <T>(path: string): Promise<T | undefined> => {
  try {
    return await readJson<T>(path);
  } catch (err) {
    if (!missing(err)) throw err;
    return undefined;
  }
};
const rowsOf = (body: Body, key: string): RecordRow[] => {
  const rows = body[key];
  if (!Array.isArray(rows)) throw new Error(`Expected ${key} array`);
  return rows as RecordRow[];
};
const sharedView = (v: RecordRow) =>
  v['active'] === true &&
  (v['restriction'] === null || (v['restriction'] as Body | undefined)?.['type'] === 'Group');
const itemId = (row: RecordRow) => {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) throw new Error('Invalid API item id');
  return row.id;
};
const failureStatus = (err: unknown) =>
  err instanceof ZendeskApiError && (err.status === 403 || err.status === 404)
    ? ('skipped' as const)
    : ('failed' as const);
const errorOf = (err: unknown) => ({
  status: err instanceof ZendeskApiError ? err.status : null,
  body: (err instanceof ZendeskApiError ? err.body : String(err)).slice(0, 500),
});

const validateManifest = (manifest: GoldenManifest, options: GoldensOptions) => {
  if (
    manifest.kind !== 'goldens' ||
    manifest.subdomain !== options.subdomain ||
    manifest.data_snapshot !== options.dataSnapshot ||
    !manifest.stages ||
    !manifest.options ||
    !Number.isFinite(Date.parse(manifest.started_at))
  )
    throw new Error('Resume manifest does not belong to this golden snapshot');
  settingsFor(manifest.options);
  for (const [key, value] of Object.entries(options.options ?? {}))
    if (manifest.options[key as keyof GoldenSettings] !== value)
      throw new Error('Options cannot change when resuming');
  if (options.stages?.some((name) => !manifest.stages[name]))
    throw new Error('Resume stages must exist in the original snapshot');
  validateStates(manifest.stages);
};
const validateStates = (stages: GoldenManifest['stages']) => {
  for (const [name, state] of Object.entries(stages)) {
    if (
      !GOLDEN_STAGES.includes(name as GoldenStage) ||
      !state?.files ||
      !['pending', 'running', 'done', 'skipped', 'failed'].includes(state.status)
    )
      throw new Error('Invalid stage checkpoint');
    for (const file of Object.keys(state.files))
      if (!FIXED_FILES.has(file) && !ITEM_FILE.test(file))
        throw new Error('Invalid checkpoint filename');
  }
};

/** Preparation reserves a snapshot with a durable manifest before a tool returns. */
export const prepareGoldens = async (options: GoldensOptions) => {
  validateOptions(options);
  const deps = options.deps ?? defaultDeps;
  const root = resolve(options.exportDir);
  const input = join(root, options.dataSnapshot);
  await safeDirectory(input, false);
  await options.getToken();
  let manifest: GoldenManifest | undefined;
  let snapshot = '';
  if (options.resume !== undefined) {
    snapshot = join(root, options.resume);
    await safeDirectory(snapshot, false);
    manifest = await readManifest<GoldenManifest>(snapshot);
    validateManifest(manifest, options);
  }
  const requestState: { current?: StageState } = {};
  const get = createPacedGet(options.subdomain, options.getToken, options.rates, deps, () => {
    if (requestState.current) requestState.current.requests++;
  });
  const me = await get<Body>('standard', '/users/me');
  const user = me['user'] as { id: number; role: string };
  if (!Number.isSafeInteger(user?.id)) throw new Error('Invalid current user response');
  if (!manifest) {
    const at = new Date(deps.now());
    snapshot = join(root, snapshotDirName(`${options.subdomain}-goldens`, at));
    await mkdir(snapshot, { mode: 0o700 });
    manifest = {
      subdomain: options.subdomain,
      kind: 'goldens',
      data_snapshot: options.dataSnapshot,
      started_at: at.toISOString(),
      current_user: { id: user.id, role: user.role },
      options: settingsFor(options.options),
      stages: {},
    };
    for (const name of GOLDEN_STAGES.filter((stage) => options.stages?.includes(stage) ?? true))
      manifest.stages[name] = {
        status: 'pending',
        requests: 0,
        items: 0,
        files: {},
        started_at: at.toISOString(),
        duration_ms: 0,
      };
  }
  if (manifest.current_user.id !== user.id)
    throw new Error('Resume requires the original recording user');
  delete manifest.finished_at;
  await writeManifest(snapshot, manifest);
  const prepared = manifest;
  return {
    snapshot,
    manifest,
    run: () => executeGoldens(options, snapshot, input, prepared, deps, get, requestState, me),
  };
};

const executeGoldens = async (
  options: GoldensOptions,
  snapshot: string,
  input: string,
  manifest: GoldenManifest,
  deps: ExportDeps,
  get: ReturnType<typeof createPacedGet>,
  requestState: { current?: StageState },
  me: Body,
) => {
  const now = () => new Date(deps.now()).toISOString();
  const checkpoint = async () => {
    await writeManifest(snapshot, manifest);
    options.onProgress?.(manifest, snapshot);
  };
  const adapter: typeof zendeskGet = (_subdomain, _token, path, params) =>
    get('standard', path, params);
  const request = (path: string, params?: Record<string, string>) =>
    get<Body>('standard', path, params);
  const checkAuth = async (err: unknown) => {
    if (!(err instanceof ZendeskApiError && err.status === 401)) return;
    try {
      await request('/users/me');
    } catch (authError) {
      if (authError instanceof ZendeskApiError && authError.status === 401) {
        await checkpoint();
        throw err;
      }
    }
  };
  const safeResult = async (call: () => Promise<unknown>): Promise<Body> => {
    try {
      return { result: await call() };
    } catch (err) {
      await checkAuth(err);
      return { error: errorOf(err) };
    }
  };
  const write = async (state: StageState, file: string, value: unknown) => {
    const target = snapshotFile(snapshot, file);
    await safeDirectory(resolve(target, '..'), true);
    await writeJsonFile(`${target}.tmp`, value);
    await rename(`${target}.tmp`, target);
    state.files[file] = await readFileStats(snapshot, file);
  };
  const pages = async (path: string, consume: (body: Body) => boolean | undefined) => {
    let body = await firstPage(options.subdomain, '', path, adapter);
    const seen = new Set<string>();
    while (true) {
      const stop = consume(body);
      await checkpoint();
      if (stop) return;
      const next: ApiRequest | undefined = nextRequest(body, options.subdomain);
      if (!next) return;
      const key = JSON.stringify(next);
      if (seen.has(key)) throw new Error('Pagination made no progress');
      seen.add(key);
      body = await request(next.path, next.params);
    }
  };
  const list = async (path: string, key: string) => {
    const collected: RecordRow[] = [];
    await pages(path, (body) => {
      collected.push(...rowsOf(body, key));
      return undefined;
    });
    return collected;
  };
  let tickets: RecordRow[] | undefined;
  const getTickets = async () => {
    tickets ??= await readLatestTickets(input);
    return tickets;
  };
  const sample = async (state: StageState, stage: 'macros' | 'slas') => {
    const file = `${stage}/sample.json`;
    const saved = await readOptional<Array<{ ticket_id: number; stratum: string }>>(
      snapshotFile(snapshot, file),
    );
    if (saved) return saved;
    const all = await getTickets();
    const selected =
      stage === 'macros'
        ? stratifiedSample(all, manifest.options.macroSample, macroKey)
        : slaSample(all, manifest.options.slaSample);
    const result = selected.map((t) => ({
      ticket_id: t.id,
      stratum: stage === 'macros' ? macroKey(t) : slaKey(t),
    }));
    await write(state, file, result);
    await checkpoint();
    return result;
  };
  const recordViews = async (state: StageState) => {
    await safeDirectory(join(snapshot, 'views'), true);
    const views = (await list('/views', 'views')).filter(sharedView);
    const index: Body[] = [];
    for (const view of views) {
      const id = itemId(view);
      const file = `views/${id}.json`;
      let observation = await readOptional<Body>(snapshotFile(snapshot, file));
      if (!observation) {
        observation = {
          view: pick(view, ['id', 'title', 'restriction', 'conditions', 'execution', 'position']),
          started_at: now(),
        };
        try {
          observation['count'] = await request(`/views/${id}/count`);
          const ticketIds = (await list(`/views/${id}/tickets`, 'tickets')).map((t) => t.id);
          observation['ticket_ids'] = ticketIds;
          observation['ticket_ids_total'] = ticketIds.length;
          const rows: unknown[] = [];
          let columns: unknown = [];
          let groups: unknown = [];
          let total: unknown;
          let truncated = false;
          await pages(`/views/${id}/execute`, (body) => {
            const executed = body;
            const values = rowsOf(executed, 'rows');
            columns = executed['columns'];
            groups = executed['groups'];
            total = body['count'] ?? null;
            const remaining = manifest.options.viewRowCap - rows.length;
            rows.push(...values.slice(0, remaining));
            const hasNext = nextRequest(body, options.subdomain) !== undefined;
            truncated =
              values.length > remaining ||
              (rows.length >= manifest.options.viewRowCap && hasNext) ||
              (typeof total === 'number' && total > rows.length);
            return rows.length >= manifest.options.viewRowCap;
          });
          observation['execute'] = {
            columns,
            groups,
            rows,
            rows_total_reported: total,
            rows_truncated: truncated,
          };
          observation['status'] = 'done';
        } catch (err) {
          await checkAuth(err);
          observation['error'] = errorOf(err);
          observation['status'] = failureStatus(err);
          observation['reason'] =
            err instanceof ZendeskApiError && failureStatus(err) === 'skipped'
              ? skipReason(err)
              : String(err);
        }
        observation['finished_at'] = now();
        await write(state, file, observation);
      }
      index.push({
        id,
        status: observation['status'],
        count: observation['count'],
        ticket_ids_total: observation['ticket_ids_total'],
        error: observation['error'],
        reason: observation['reason'],
      });
      state.items = index.length;
      await write(state, 'views/index.json', index);
      await checkpoint();
    }
    await write(state, 'views/index.json', index);
  };
  const recordMacros = async (state: StageState) => {
    await safeDirectory(join(snapshot, 'macros'), true);
    const selected = await sample(state, 'macros');
    const macros = (await list('/macros', 'macros')).filter((m) => m['active'] === true);
    const index: Body[] = [];
    for (const macro of macros) {
      const id = itemId(macro);
      const file = `macros/${id}.json`;
      let observation = await readOptional<Body>(snapshotFile(snapshot, file));
      if (!observation) {
        const generic = await safeResult(() => request(`/macros/${id}/apply`));
        const previews: Body[] = [];
        for (const { ticket_id } of selected)
          previews.push({
            ticket_id,
            ...(await safeResult(() => request(`/tickets/${ticket_id}/macros/${id}/apply`))),
          });
        observation = {
          macro: pick(macro, ['id', 'title', 'actions', 'restriction']),
          generic: generic['error'] ? generic : generic['result'],
          previews,
        };
        await write(state, file, observation);
      }
      index.push({
        id,
        previews: (observation['previews'] as Body[]).length,
        errors: (observation['previews'] as Body[]).filter((p) => p['error']).length,
        status: 'done',
      });
      state.items = index.length;
      await write(state, 'macros/index.json', index);
      await checkpoint();
    }
    await write(state, 'macros/index.json', index);
  };
  const append = async (state: StageState, file: string, values: unknown[]) => {
    state.files[file] = await appendPage(snapshot, file, values, state.files[file]);
  };
  const recordSlas = async (state: StageState) => {
    await safeDirectory(join(snapshot, 'slas'), true);
    const selected = await sample(state, 'slas');
    const files = Object.fromEntries(
      ['slas.ndjson', 'audits.ndjson'].map((file) => [
        file,
        state.files[file] ?? { bytes: 0, lines: 0 },
      ]),
    );
    await truncateFiles(snapshot, files);
    for (const file of Object.keys(files)) await append(state, file, []);
    await checkpoint();
    for (let offset = state.sla_offset ?? 0; offset < selected.length; offset += 100) {
      const batch = selected.slice(offset, offset + 100);
      const result = await safeResult(() =>
        request('/tickets/show_many', {
          ids: batch.map((t) => t.ticket_id).join(','),
          include: 'slas,metric_sets,metric_events',
        }),
      );
      if (result['error'])
        await append(
          state,
          'slas.ndjson',
          batch.map((t) => ({
            ticket_id: t.ticket_id,
            recorded_at: now(),
            error: result['error'],
          })),
        );
      else {
        const body = result['result'] as Body;
        const records = rowsOf(body, 'tickets').map((ticket) => ({
          ticket_id: ticket.id,
          recorded_at: now(),
          ticket: pick(ticket, [
            'id',
            'status',
            'priority',
            'group_id',
            'assignee_id',
            'ticket_form_id',
            'brand_id',
            'created_at',
            'updated_at',
          ]),
          slas: ticket['slas'],
          metric_set: Array.isArray(body['metric_sets'])
            ? (body['metric_sets'] as Body[]).find((m) => m['ticket_id'] === ticket.id)
            : body['metric_sets'],
          metric_events: matchEvents(body['metric_events'], ticket.id),
        }));
        const returned = new Set(records.map((record) => record.ticket_id));
        const absent = batch
          .filter((t) => !returned.has(t.ticket_id))
          .map((t) => ({
            ticket_id: t.ticket_id,
            recorded_at: now(),
            error: { status: 404, body: 'Ticket omitted from show_many response' },
          }));
        await append(state, 'slas.ndjson', [...records, ...absent]);
      }
      state.sla_offset = offset + batch.length;
      state.items = state.sla_offset;
      await checkpoint();
    }
    for (let offset = state.audit_offset ?? 0; offset < selected.length; offset++) {
      const ticket_id = selected[offset]?.ticket_id;
      const result = await safeResult(() => list(`/tickets/${ticket_id}/audits`, 'audits'));
      await append(state, 'audits.ndjson', [
        { ticket_id, ...(result['error'] ? result : { audits: result['result'] }) },
      ]);
      state.audit_offset = offset + 1;
      await checkpoint();
    }
  };
  const recordSearch = async (state: StageState) => {
    const queryFile = manifest.options.queries;
    if (!queryFile) await safeDirectory(join(input, 'config'), false);
    const queries = queryFile
      ? validateQueries(await readJson<unknown>(queryFile))
      : buildSearchQueries(
          {
            tickets: await getTickets(),
            users: await readRows(join(input, 'users.ndjson'), ['id', 'email']),
            groups: await readRows(join(input, 'groups.ndjson'), ['id', 'name']),
            organizations: await readRows(join(input, 'organizations.ndjson'), ['id', 'name']),
            brands: await readJson<RecordRow[]>(join(input, 'config/brands.json')),
            forms: await readJson<RecordRow[]>(join(input, 'config/ticket_forms.json')),
          },
          new Date((await readManifest<{ started_at: string }>(input)).started_at),
        );
    const results: Body[] = [];
    for (const { id, query } of queries) {
      const recorded = { id, query, origin: queryFile ? 'file' : 'generated', recorded_at: now() };
      const result = await safeResult(async () => ({
        count: await request('/search/count', { query }),
        top_relevance_ids: rowsOf(
          await request('/search', { query, per_page: '100' }),
          'results',
        ).map((t) => t.id),
        top_created_desc_ids: rowsOf(
          await request('/search', {
            query,
            sort_by: 'created_at',
            sort_order: 'desc',
            per_page: '100',
          }),
          'results',
        ).map((t) => t.id),
      }));
      results.push({ ...recorded, ...(result['error'] ? result : (result['result'] as Body)) });
      state.items = results.length;
      await write(state, 'search.json', results);
      await checkpoint();
    }
    await write(state, 'search.json', results);
  };
  const recorders: Record<GoldenStage, (state: StageState) => Promise<void>> = {
    context: async (state) => {
      await write(state, 'context.json', {
        ...me,
        group_memberships: await list(
          `/users/${manifest.current_user.id}/group_memberships`,
          'group_memberships',
        ),
        recorded_at: now(),
      });
      state.items = 1;
    },
    views: recordViews,
    macros: recordMacros,
    slas: recordSlas,
    search: recordSearch,
  };
  for (const name of GOLDEN_STAGES) {
    const state = manifest.stages[name];
    if (!state || state.status === 'done' || (options.stages && !options.stages.includes(name)))
      continue;
    requestState.current = state;
    if (state.status === 'pending') state.started_at = now();
    state.status = 'running';
    delete state.reason;
    delete state.finished_at;
    await checkpoint();
    try {
      await recorders[name](state);
      state.status = 'done';
    } catch (err) {
      state.status = failureStatus(err);
      state.reason =
        err instanceof ZendeskApiError && state.status === 'skipped'
          ? skipReason(err)
          : String(err);
      await checkAuth(err);
    }
    state.finished_at = now();
    state.duration_ms = deps.now() - Date.parse(state.started_at);
    await checkpoint();
  }
  manifest.finished_at = now();
  await checkpoint();
  return { snapshot, manifest, duration_ms: deps.now() - Date.parse(manifest.started_at) };
};
const matchEvents = (raw: unknown, id: number): unknown => {
  // TODO: Confirm the metric_events sideload schema; preserve unrecognized shapes raw.
  if (
    Array.isArray(raw) &&
    raw.every((item) => item && typeof item === 'object' && 'ticket_id' in item)
  )
    return raw.filter((item) => (item as Body)['ticket_id'] === id);
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Object.keys(raw).every((key) => TICKET_ID_KEY.test(key))
  )
    return (raw as Body)[String(id)] ?? [];
  return raw;
};
const validateQueries = (value: unknown): SearchQuery[] => {
  if (
    !Array.isArray(value) ||
    value.some(
      (q) =>
        !q ||
        typeof q.id !== 'string' ||
        !q.id ||
        typeof q.query !== 'string' ||
        !q.query.startsWith('type:ticket '),
    ) ||
    new Set(value.map((q) => q.id)).size !== value.length
  )
    throw new Error(
      'Queries must be an array of unique { id, query } entries prefixed type:ticket',
    );
  return value as SearchQuery[];
};
export const runGoldens = async (options: GoldensOptions) => (await prepareGoldens(options)).run();
