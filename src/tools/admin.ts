import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import * as z from 'zod/v4';
import { ZendeskApiError, zendeskGet } from '../client/zendesk-api';
import { getBaseUrl } from '../constants';
import type { ToolContext, ToolDefinition } from './definitions';

/**
 * A list Zendesk serves per item of its parent rather than inline (a schedule's
 * holidays), fetched for every parent item and attached to it under `attachAs`.
 */
interface NestedListSpec {
  readonly attachAs: string;
  /** The parent property that identifies it in the nested path (`id`, or `key`). */
  readonly idField: string;
  readonly path: (id: string) => string;
  readonly responseKey: string;
}

/**
 * Where Zendesk lists one part of the account configuration, and which property
 * of the response carries it. `single` marks an endpoint that answers with one
 * object instead of a list.
 */
interface ConfigResourceSpec {
  readonly path: string;
  readonly responseKey: string;
  readonly single?: true;
  readonly nested?: NestedListSpec;
}

const RESOURCE_KEYS = [
  'account_settings',
  'brands',
  'locales',
  'support_addresses',
  'schedules',
  'groups',
  'group_memberships',
  'custom_roles',
  'ticket_forms',
  'ticket_fields',
  'custom_statuses',
  'user_fields',
  'organization_fields',
  'triggers',
  'trigger_categories',
  'automations',
  'macros',
  'views',
  'sla_policies',
  'group_sla_policies',
  'webhooks',
  'targets',
  'dynamic_content',
  'satisfaction_reasons',
  'sharing_agreements',
  'app_installations',
  'routing_attributes',
  'custom_objects',
] as const;

type ConfigResourceKey = (typeof RESOURCE_KEYS)[number];

/**
 * The account-configuration catalog, in export order: what an admin sets up in
 * Admin Center, not the data that flows through it (tickets, users, articles).
 * The keys are this tool's own names, so a renamed endpoint changes one row here
 * and nothing a caller depends on.
 */
export const CONFIG_RESOURCES: Readonly<Record<ConfigResourceKey, ConfigResourceSpec>> = {
  account_settings: { path: '/account/settings', responseKey: 'settings', single: true },
  brands: { path: '/brands', responseKey: 'brands' },
  locales: { path: '/locales', responseKey: 'locales' },
  support_addresses: { path: '/recipient_addresses', responseKey: 'recipient_addresses' },
  schedules: {
    path: '/business_hours/schedules',
    responseKey: 'schedules',
    nested: {
      attachAs: 'holidays',
      idField: 'id',
      path: (id) => `/business_hours/schedules/${id}/holidays`,
      responseKey: 'holidays',
    },
  },
  groups: { path: '/groups', responseKey: 'groups' },
  group_memberships: { path: '/group_memberships', responseKey: 'group_memberships' },
  custom_roles: { path: '/custom_roles', responseKey: 'custom_roles' },
  ticket_forms: { path: '/ticket_forms', responseKey: 'ticket_forms' },
  ticket_fields: { path: '/ticket_fields', responseKey: 'ticket_fields' },
  custom_statuses: { path: '/custom_statuses', responseKey: 'custom_statuses' },
  user_fields: { path: '/user_fields', responseKey: 'user_fields' },
  organization_fields: { path: '/organization_fields', responseKey: 'organization_fields' },
  triggers: { path: '/triggers', responseKey: 'triggers' },
  trigger_categories: { path: '/trigger_categories', responseKey: 'trigger_categories' },
  automations: { path: '/automations', responseKey: 'automations' },
  macros: { path: '/macros', responseKey: 'macros' },
  views: { path: '/views', responseKey: 'views' },
  sla_policies: { path: '/slas/policies', responseKey: 'sla_policies' },
  group_sla_policies: { path: '/group_slas/policies', responseKey: 'group_sla_policies' },
  webhooks: { path: '/webhooks', responseKey: 'webhooks' },
  targets: { path: '/targets', responseKey: 'targets' },
  dynamic_content: { path: '/dynamic_content/items', responseKey: 'items' },
  satisfaction_reasons: { path: '/satisfaction_reasons', responseKey: 'reasons' },
  sharing_agreements: { path: '/sharing_agreements', responseKey: 'sharing_agreements' },
  app_installations: { path: '/apps/installations', responseKey: 'installations' },
  routing_attributes: {
    path: '/routing/attributes',
    responseKey: 'attributes',
    nested: {
      attachAs: 'values',
      idField: 'id',
      path: (id) => `/routing/attributes/${id}/values`,
      responseKey: 'attribute_values',
    },
  },
  custom_objects: {
    path: '/custom_objects',
    responseKey: 'custom_objects',
    nested: {
      attachAs: 'fields',
      idField: 'key',
      path: (key) => `/custom_objects/${key}/fields`,
      responseKey: 'custom_object_fields',
    },
  },
};

/**
 * Pages read per list before the export stops and flags it truncated. At 100
 * items a page that is 20 000 objects, far beyond any account's configuration:
 * this guards against a pagination loop, it is not a real cap.
 */
export const MAX_PAGES = 200;

// Cursor pagination is asked for first: Zendesk's offset pagination refuses
// anything past 100 pages (10 000 records) with a 400, cursor has no such cap.
const CURSOR_FIRST_PAGE: Readonly<Record<string, string>> = { 'page[size]': '100' };

interface ApiRequest {
  path: string;
  params: Record<string, string>;
}

/**
 * The request for the next page, or `undefined` on the last one. Zendesk pages a
 * configuration list either by offset (`next_page`) or by cursor (`meta.has_more`
 * + `links.next`); whichever the endpoint answered with is followed. The link
 * comes from the response, so it is followed only on this account's API: any
 * other target would receive the bearer token.
 */
export const nextRequest = (
  body: Record<string, unknown>,
  subdomain: string,
): ApiRequest | undefined => {
  const meta = body['meta'] as { has_more?: unknown } | undefined;
  const links = body['links'] as { next?: unknown } | undefined;
  const link =
    meta?.has_more === true && typeof links?.next === 'string' ? links.next : body['next_page'];
  if (typeof link !== 'string') return undefined;

  const url = new URL(link);
  const api = new URL(getBaseUrl(subdomain));
  if (url.origin !== api.origin || !url.pathname.startsWith(`${api.pathname}/`)) {
    throw new Error(
      `Refusing to follow a pagination link outside this account API: ${url.origin}${url.pathname}`,
    );
  }
  return {
    path: url.pathname.slice(api.pathname.length),
    params: Object.fromEntries(url.searchParams),
  };
};

// Response properties that frame a page rather than carry the resource.
const PAGE_FRAME_KEYS: ReadonlySet<string> = new Set([
  'meta',
  'links',
  'next_page',
  'previous_page',
  'count',
]);

/**
 * The resource carried by one response: its documented key, or else the one list
 * the response holds, so an endpoint whose key differs from the catalog still
 * exports instead of failing on a name.
 */
export const extractItems = (body: Record<string, unknown>, responseKey: string): unknown => {
  if (responseKey in body) return body[responseKey];
  const lists = Object.entries(body).filter(
    ([key, value]) => !PAGE_FRAME_KEYS.has(key) && Array.isArray(value),
  );
  const [only] = lists;
  if (lists.length === 1 && only) return only[1];
  throw new Error(
    `Unexpected response shape: no "${responseKey}" list (keys: ${Object.keys(body).join(', ')})`,
  );
};

/** `<subdomain>-<UTC timestamp>`, safe as a folder name on every OS. */
export const snapshotDirName = (subdomain: string, at: Date): string =>
  `${subdomain.replace(/[^a-z0-9-]/gi, '_')}-${at.toISOString().replace(/[:.]/g, '-')}`;

type Body = Record<string, unknown>;

const listOf = (body: Body, responseKey: string): unknown[] => {
  const items = extractItems(body, responseKey);
  if (!Array.isArray(items)) {
    throw new Error(`Unexpected response shape: "${responseKey}" is not a list`);
  }
  return items;
};

// The first page, by cursor when the endpoint supports it. One that does not
// answers 400 to `page[size]`, and is then read by offset.
const firstPage = async (subdomain: string, token: string, path: string): Promise<Body> => {
  try {
    return await zendeskGet<Body>(subdomain, token, path, { ...CURSOR_FIRST_PAGE });
  } catch (err) {
    if (!(err instanceof ZendeskApiError && err.status === 400)) throw err;
    return zendeskGet<Body>(subdomain, token, path);
  }
};

interface FetchedList {
  items: unknown[];
  truncated: boolean;
}

const fetchList = async (
  subdomain: string,
  token: string,
  path: string,
  responseKey: string,
): Promise<FetchedList> => {
  const items: unknown[] = [];
  let body = await firstPage(subdomain, token, path);
  for (let pages = 1; ; pages += 1) {
    items.push(...listOf(body, responseKey));
    const next = nextRequest(body, subdomain);
    if (next === undefined) return { items, truncated: false };
    if (pages >= MAX_PAGES) return { items, truncated: true };
    body = await zendeskGet<Body>(subdomain, token, next.path, next.params);
  }
};

// Attach each parent's nested list, so the export carries it without a second
// lookup. A parent without the identifying property keeps no nested list.
const attachNested = async (
  subdomain: string,
  token: string,
  parents: unknown[],
  nested: NestedListSpec,
): Promise<{ items: unknown[]; truncated: boolean }> => {
  let truncated = false;
  const items: unknown[] = [];
  for (const parent of parents) {
    const id = (parent as Body)[nested.idField];
    if (typeof id !== 'string' && typeof id !== 'number') {
      items.push(parent);
      continue;
    }
    const child = await fetchList(
      subdomain,
      token,
      nested.path(encodeURIComponent(String(id))),
      nested.responseKey,
    );
    truncated ||= child.truncated;
    items.push({ ...(parent as Body), [nested.attachAs]: child.items });
  }
  return { items, truncated };
};

interface Fetched {
  data: unknown;
  items: number;
  truncated: boolean;
}

const fetchResource = async (
  subdomain: string,
  token: string,
  spec: ConfigResourceSpec,
): Promise<Fetched> => {
  if (spec.single) {
    const body = await zendeskGet<Body>(subdomain, token, spec.path);
    return { data: extractItems(body, spec.responseKey), items: 1, truncated: false };
  }
  const list = await fetchList(subdomain, token, spec.path, spec.responseKey);
  const result = spec.nested
    ? await attachNested(subdomain, token, list.items, spec.nested)
    : { items: list.items, truncated: false };
  return {
    data: result.items,
    items: result.items.length,
    truncated: list.truncated || result.truncated,
  };
};

type ManifestEntry = { resource: ConfigResourceKey; endpoint: string } & (
  | { status: 'exported'; items: number; file: string; truncated: boolean }
  | { status: 'skipped' | 'failed'; reason: string }
);

// The `error` code Zendesk puts in a JSON error body (`InvalidEndpoint`,
// `Forbidden`...), which tells a missing feature from a wrong path.
const zendeskErrorCode = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
};

const skipReason = (err: ZendeskApiError): string => {
  const code = zendeskErrorCode(err.body);
  const status = `${err.status}${code ? ` ${code}` : ''}`;
  return err.status === 403
    ? `No access (${status}): the signed-in account cannot read it, or the plan lacks it.`
    : `Not available on this account (${status}): the feature is off or not on this plan, or the endpoint does not exist.`;
};

// A 401 on one endpoint means either the token or that endpoint; /users/me
// settles which. Only a token Zendesk rejects outright is worth the server's
// 401 backstop (which drops it): one odd endpoint must not cost the sign-in.
const tokenStillWorks = async (subdomain: string, token: string): Promise<boolean> => {
  try {
    await zendeskGet(subdomain, token, '/users/me');
    return true;
  } catch (err) {
    return !(err instanceof ZendeskApiError && err.status === 401);
  }
};

/**
 * Export one resource. A resource the account cannot read (403) or that is not
 * available on it (404) is skipped, and any other failure recorded, so one gap
 * never costs the rest of the export. A 401 is rethrown only when the token
 * itself is rejected, so the server's backstop can recover it.
 */
const exportResource = async (
  ctx: ToolContext,
  snapshot: string,
  resource: ConfigResourceKey,
): Promise<ManifestEntry> => {
  const spec = CONFIG_RESOURCES[resource];
  const endpoint = `/api/v2${spec.path}`;
  const token = await ctx.getToken();
  try {
    const fetched = await fetchResource(ctx.subdomain, token, spec);
    const file = `${resource}.json`;
    await writeFile(join(snapshot, file), `${JSON.stringify(fetched.data, null, 2)}\n`, 'utf8');
    return {
      resource,
      endpoint,
      status: 'exported',
      items: fetched.items,
      file,
      truncated: fetched.truncated,
    };
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    if (err instanceof ZendeskApiError && err.status === 401) {
      if (!(await tokenStillWorks(ctx.subdomain, token))) throw err;
      return {
        resource,
        endpoint,
        status: 'failed',
        reason:
          'Unauthorized (401) on this endpoint, although the token still works for /users/me.',
      };
    }
    if (err instanceof ZendeskApiError && (err.status === 403 || err.status === 404)) {
      return { resource, endpoint, status: 'skipped', reason: skipReason(err) };
    }
    return { resource, endpoint, status: 'failed', reason: err.message };
  }
};

// The summary is a Markdown table: a raw error body (an HTML page, a message
// with `|` or newlines) would break it, so the cell gets one short line. The
// manifest keeps the full reason.
const REASON_CELL_MAX = 160;
const WHITESPACE_RUN = /\s+/g;
const PIPE = /\|/g;

const reasonCell = (reason: string): string => {
  const line = reason.replace(WHITESPACE_RUN, ' ').replace(PIPE, '/').trim();
  return line.length > REASON_CELL_MAX ? `${line.slice(0, REASON_CELL_MAX - 1)}…` : line;
};

const statusCell = (entry: ManifestEntry): string => {
  if (entry.status === 'exported') return entry.truncated ? 'exported (truncated)' : 'exported';
  return `${entry.status}: ${reasonCell(entry.reason)}`;
};

const formatSummary = (subdomain: string, snapshot: string, entries: ManifestEntry[]): string => {
  const count = (status: ManifestEntry['status']) =>
    entries.filter((e) => e.status === status).length;
  const rows = entries.map(
    (e) => `| ${e.resource} | ${statusCell(e)} | ${e.status === 'exported' ? e.items : '-'} |`,
  );
  return [
    `Exported the ${subdomain} account configuration to ${snapshot}`,
    `${count('exported')} exported, ${count('skipped')} skipped, ${count('failed')} failed. manifest.json has the per-resource details; each <resource>.json holds the raw Zendesk objects.`,
    '',
    '| Resource | Status | Items |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
};

const writeManifest = (snapshot: string, manifest: object): Promise<void> =>
  writeFile(join(snapshot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// A UNC path (\\host\share, or //host/share) counts as absolute on Windows, and
// would make the server open an SMB connection to whatever host the caller names.
const isNetworkPath = (path: string): boolean => path.startsWith('\\\\') || path.startsWith('//');

/**
 * stdio only: over HTTP the files would land on the server host, not on the
 * caller's machine, and listing a tool that can never run there would only waste
 * an agent's call. So the namespace is simply absent without local file access.
 */
export const createAdminTools = (ctx: ToolContext): ToolDefinition[] =>
  ctx.localFileAccess ? [exportAccountConfig(ctx)] : [];

const exportAccountConfig = (ctx: ToolContext): ToolDefinition => ({
  name: 'export_account_config',
  namespace: 'admin',
  // `readOnly` is about Zendesk (it keeps the tool on a --read-only server,
  // where snapshotting production is the point); `readOnlyHint` is about the
  // client's environment, which the export does change by writing files, so it
  // is honestly false. Never destructive: the snapshot folder is always new.
  readOnly: true,
  title: 'Export Zendesk Account Configuration',
  description:
    "Export the Zendesk account's admin configuration to local JSON files, one per resource: business rules (triggers, automations, macros, views), ticket forms, fields and statuses, SLA policies, schedules with their holidays, groups, roles, brands, webhooks, account settings and more. " +
    'Use it to audit, document, diff or migrate a Zendesk setup, then read the files for the details instead of pulling them through the conversation; to look up one field id, macro, view or SLA policy during ticket work, use list_ticket_fields, list_macros, list_views or list_sla_policies instead. ' +
    'It only reads from Zendesk; on the machine running the server it creates a new timestamped folder under `directory` and never overwrites an earlier export. ' +
    'Returns the folder path and a per-resource summary: items exported, or why a resource was skipped (403: no access; 404: not available on this account) or failed. ' +
    'Needs an admin sign-in; available over stdio only.',
  inputSchema: z.object({
    directory: z
      .string()
      .min(1)
      .describe(
        'Absolute local path of a directory on the machine running the server (not a network share), created if missing. Each export goes into a new `<subdomain>-<timestamp>` folder inside it, so earlier exports stay untouched.',
      ),
    resources: z
      .array(z.enum(RESOURCE_KEYS))
      .min(1)
      .optional()
      .describe(
        'Which parts of the configuration to export, by catalog name (e.g. ["triggers", "automations", "ticket_forms"]). Omit to export the whole catalog, which is what an audit or a migration needs.',
      ),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (params) => {
    const { directory, resources } = params as {
      directory: string;
      resources?: ConfigResourceKey[];
    };
    if (!isAbsolute(directory) || isNetworkPath(directory)) {
      throw new Error(
        'directory must be an absolute local path on the machine running the server, not a relative path or a network share.',
      );
    }
    const selected = RESOURCE_KEYS.filter((key) => resources?.includes(key) ?? true);
    // Sign-in first: a call that still needs one must leave no empty folder behind.
    await ctx.getToken();
    const exportedAt = new Date();
    await mkdir(directory, { recursive: true });
    // Not recursive: the snapshot folder must be new, so a second export can
    // never write into (and overwrite) an earlier one.
    const snapshot = join(directory, snapshotDirName(ctx.subdomain, exportedAt));
    await mkdir(snapshot);

    const manifest = { subdomain: ctx.subdomain, exported_at: exportedAt.toISOString() };
    const entries: ManifestEntry[] = [];
    try {
      for (const resource of selected) {
        // Sequential on purpose: the export is a one-off, and a burst of parallel
        // reads would only trade wall time for the account's rate limit.
        entries.push(await exportResource(ctx, snapshot, resource));
      }
    } catch (err) {
      // Whatever stops the run (a rejected token), the folder still says what
      // was exported before it and why it stopped.
      const aborted = err instanceof Error ? err.message : String(err);
      await writeManifest(snapshot, { ...manifest, aborted, resources: entries });
      throw err;
    }
    await writeManifest(snapshot, { ...manifest, resources: entries });
    return {
      content: [{ type: 'text', text: formatSummary(ctx.subdomain, snapshot, entries) }],
    };
  },
});
