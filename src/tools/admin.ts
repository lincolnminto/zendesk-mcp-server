import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { zendeskGet } from '../client/zendesk-api';
import {
  type ApiRequest,
  type ConfigResourceKey,
  formatSummary,
  nextRequest,
  RESOURCE_KEYS,
  runConfigExport,
  snapshotDirName,
} from '../export/account-config';
import { createGoldensTool } from '../export/goldens-tool';
import { createDataExportTool } from '../export/tool';
import type { ToolContext, ToolDefinition } from './definitions';

/**
 * Opt-in: the admin namespace exists only when the operator configured an export
 * directory (`--export-dir`, stdio only). Off by default, so no existing surface
 * changes, notably a `single`-mode proxy's read-only hints.
 */
export const createAdminTools = (ctx: ToolContext): ToolDefinition[] =>
  ctx.exportDir
    ? [
        exportAccountConfig(ctx, ctx.exportDir),
        createDataExportTool(ctx, ctx.exportDir),
        createGoldensTool(ctx, ctx.exportDir),
        listApiTokens(ctx),
      ]
    : [];

interface ApiTokenMetadata {
  id: number;
  description: string | null;
  active: boolean;
  created_at: string;
  updated_at: string | null;
  last_used: string | null;
}

const listApiTokens = (ctx: ToolContext): ToolDefinition => ({
  name: 'list_api_tokens',
  namespace: 'admin',
  readOnly: true,
  title: 'List Zendesk API Tokens',
  description:
    'List all account API tokens with their metadata and last usage time, excluding token values. ' +
    'Use it to audit active or unused API credentials; returns id, description, active, created_at, updated_at and last_used (null if never used), following every page. ' +
    'Only reads Zendesk and writes no local files; never returns token or visible_token values. ' +
    'Requires an admin or an agent with Manage APIs permission; available only when the server was started with an export directory. ' +
    'The Zendesk endpoint is deprecated and scheduled for removal on April 30, 2027.',
  inputSchema: z.object({}),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async () => {
    const token = await ctx.getToken();
    const apiTokens: ApiTokenMetadata[] = [];
    let next: ApiRequest | undefined = { path: '/api_tokens', params: {} };
    while (next) {
      const body = await zendeskGet<{ api_tokens: ApiTokenMetadata[]; next_page?: string | null }>(
        ctx.subdomain,
        token,
        next.path,
        next.params,
      );
      // Allowlist metadata: even a token value unexpectedly included by Zendesk
      // must never reach the caller (including its truncated visible_token).
      apiTokens.push(
        ...body.api_tokens.map(
          ({ id, description, active, created_at, updated_at, last_used }) => ({
            id,
            description,
            active,
            created_at,
            updated_at,
            last_used,
          }),
        ),
      );
      next = nextRequest(body, ctx.subdomain);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ api_tokens: apiTokens }, null, 2) }],
    };
  },
});

const exportAccountConfig = (ctx: ToolContext, exportDir: string): ToolDefinition => ({
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
    "It only reads from Zendesk; on the machine running the server it creates a new timestamped folder in the operator's export directory and never overwrites an earlier export. " +
    'Returns the folder path and a per-resource summary: items exported, or why a resource was skipped (403: no access; 404: not available on this account) or failed. ' +
    'Needs an admin sign-in; available only when the server was started with an export directory.',
  inputSchema: z.object({
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
    const { resources } = params as { resources?: ConfigResourceKey[] };
    const selected = RESOURCE_KEYS.filter((key) => resources?.includes(key) ?? true);
    // Sign-in first: a call that still needs one must leave no empty folder behind.
    await ctx.getToken();
    const exportedAt = new Date();
    await mkdir(exportDir, { recursive: true });
    // Not recursive: the snapshot folder must be new, so a second export can
    // never write into (and overwrite) an earlier one.
    const snapshot = join(exportDir, snapshotDirName(ctx.subdomain, exportedAt));
    await mkdir(snapshot);

    const entries = await runConfigExport(ctx, snapshot, selected, undefined, exportedAt);
    return {
      content: [{ type: 'text', text: formatSummary(ctx.subdomain, snapshot, entries) }],
    };
  },
});
