import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import * as z from 'zod/v4';
import { ZendeskApiError, zendeskGet } from '../client/zendesk-api';
import { getBaseUrl } from '../constants';
import type { ToolContext, ToolDefinition } from './definitions';

/**
 * Where Zendesk lists one part of the account configuration, and which property
 * of the response carries it. `single` marks an endpoint that answers with one
 * object instead of a list.
 */
interface ConfigResourceSpec {
  readonly path: string;
  readonly responseKey: string;
  readonly single?: true;
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
  schedules: { path: '/business_hours/schedules', responseKey: 'schedules' },
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
  routing_attributes: { path: '/routing/attributes', responseKey: 'attributes' },
  custom_objects: { path: '/custom_objects', responseKey: 'custom_objects' },
};

/**
 * Pages read per resource before the export stops and flags it truncated. At
 * Zendesk's 100 items a page that is 20 000 objects, far beyond any account's
 * configuration: this guards against a pagination loop, it is not a real cap.
 */
export const MAX_PAGES = 200;

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
    const body = await zendeskGet<Record<string, unknown>>(subdomain, token, spec.path);
    return { data: extractItems(body, spec.responseKey), items: 1, truncated: false };
  }
  const collected: unknown[] = [];
  let request: ApiRequest | undefined = { path: spec.path, params: {} };
  let pages = 0;
  while (request && pages < MAX_PAGES) {
    const body: Record<string, unknown> = await zendeskGet<Record<string, unknown>>(
      subdomain,
      token,
      request.path,
      request.params,
    );
    const items = extractItems(body, spec.responseKey);
    if (!Array.isArray(items)) {
      throw new Error(`Unexpected response shape: "${spec.responseKey}" is not a list`);
    }
    collected.push(...items);
    pages += 1;
    request = nextRequest(body, subdomain);
  }
  return { data: collected, items: collected.length, truncated: request !== undefined };
};

type ManifestEntry = { resource: ConfigResourceKey; endpoint: string } & (
  | { status: 'exported'; items: number; file: string; truncated: boolean }
  | { status: 'skipped' | 'failed'; reason: string }
);

/**
 * Export one resource. A resource the account cannot read (403) or whose feature
 * is off (404) is skipped, and any other failure recorded, so one gap never costs
 * the rest of the export. A 401 is rethrown: it means the token, not the
 * resource, and the server's backstop must see it to recover the token.
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
    if (!(err instanceof Error) || (err instanceof ZendeskApiError && err.status === 401)) {
      throw err;
    }
    const skipped = err instanceof ZendeskApiError && (err.status === 403 || err.status === 404);
    return { resource, endpoint, status: skipped ? 'skipped' : 'failed', reason: err.message };
  }
};

const statusCell = (entry: ManifestEntry): string => {
  if (entry.status === 'exported') return entry.truncated ? 'exported (truncated)' : 'exported';
  return `${entry.status}: ${entry.reason}`;
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

export const createAdminTools = (ctx: ToolContext): ToolDefinition[] => [
  {
    name: 'export_account_config',
    namespace: 'admin',
    readOnly: true,
    title: 'Export Zendesk Account Configuration',
    description:
      "Export the Zendesk account's admin configuration to local JSON files, one per resource: business rules (triggers, automations, macros, views), ticket forms, fields and statuses, SLA policies, schedules, groups, roles, brands, webhooks, account settings and more. " +
      'Use it to audit, document, diff or migrate a Zendesk setup, then read the files for the details instead of pulling them through the conversation. ' +
      'It only reads from Zendesk; on the machine running the server it creates a new timestamped folder under `directory` and never overwrites an earlier export. ' +
      'Returns the folder path and a per-resource summary: items exported, or why a resource was skipped (403: the account cannot read it; 404: the feature is off) or failed. ' +
      'Needs an admin sign-in and the stdio transport.',
    inputSchema: z.object({
      directory: z
        .string()
        .min(1)
        .describe(
          'Absolute path of a local directory on the machine running the server, created if missing. Each export goes into a new `<subdomain>-<timestamp>` folder inside it, so earlier exports stay untouched.',
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
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params) => {
      const { directory, resources } = params as {
        directory: string;
        resources?: ConfigResourceKey[];
      };
      if (!ctx.localFileAccess) {
        throw new Error(
          'export_account_config is not available over the HTTP transport: the files would be written on the server host, not on your machine. Run the server over stdio to export.',
        );
      }
      if (!isAbsolute(directory)) {
        throw new Error('directory must be an absolute path on the machine running the server.');
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

      const entries: ManifestEntry[] = [];
      for (const resource of selected) {
        // Sequential on purpose: the export is a one-off, and a burst of parallel
        // reads would only trade wall time for the account's rate limit.
        entries.push(await exportResource(ctx, snapshot, resource));
      }
      const manifest = {
        subdomain: ctx.subdomain,
        exported_at: exportedAt.toISOString(),
        resources: entries,
      };
      await writeFile(
        join(snapshot, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      return {
        content: [{ type: 'text', text: formatSummary(ctx.subdomain, snapshot, entries) }],
      };
    },
  },
];
