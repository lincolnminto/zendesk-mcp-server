import { resolve } from 'node:path';
import * as z from 'zod/v4';
import type { ToolContext, ToolDefinition } from '../tools/definitions';
import { DATA_STREAMS, type DataExportOptions, prepareDataExport } from './data-export';
import { readManifest } from './ndjson';

interface Job {
  snapshot: string;
  running: boolean;
  error?: string;
}
// Shared across tool contexts: even two MCP server instances cannot start two
// jobs for the same account/export directory in this process.
const jobs = new Map<string, Promise<Job>>();

export const createDataExportTool = (ctx: ToolContext, exportDir: string): ToolDefinition => ({
  name: 'export_data',
  namespace: 'admin',
  readOnly: true,
  title: 'Export Zendesk Account Data',
  description:
    'Start a resumable bulk export of Zendesk account data to local NDJSON files in the background. ' +
    'Use it for backups, audits or migration of tickets, users, organizations, events and configuration; use export_account_config for configuration alone, or search_tickets for an interactive lookup. ' +
    'Requires an admin sign-in and an operator-configured export directory on a stdio server. It only reads Zendesk with GET requests, creates a new timestamped local snapshot and never downloads attachment content; resume appends after truncating unfinished files to their last checkpoint. ' +
    'Returns the snapshot path and manifest progress immediately; call again while running to check the same job instead of starting another. Exports may take hours and stop when the server process exits; use resume with the returned folder name after a restart. ' +
    'A skipped stream lacks access or availability; failed streams can be resumed. Read manifest.json in the snapshot directory for page counts, file sizes and errors.',
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe(
        'Earliest incremental record date as ISO 8601 (for example 2025-01-01T00:00:00Z) or epoch seconds. Omit for all history; list streams always export in full. Must match the original date when resuming.',
      ),
    streams: z
      .array(z.enum(DATA_STREAMS))
      .min(1)
      .optional()
      .describe(
        'Streams to export, for example ["tickets", "users", "ticket_events"]. Omit for all data streams and configuration. Resume may select only streams in the original snapshot.',
      ),
    resume: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Existing snapshot folder name returned by an earlier export, inside the configured export directory. No path separators or .. allowed. Resumes unfinished streams using their saved cursors and file byte offsets.',
      ),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (params) => {
    const key = `${ctx.subdomain}:${resolve(exportDir)}`;
    let pending = jobs.get(key);
    if (!pending) {
      pending = startJob(
        {
          ...(params as Pick<DataExportOptions, 'since' | 'streams' | 'resume'>),
          subdomain: ctx.subdomain,
          getToken: ctx.getToken,
          exportDir,
        },
        key,
      );
      jobs.set(key, pending);
      // Preparation failures must release the reservation too.
      void pending.catch(() => {
        if (jobs.get(key) === pending) jobs.delete(key);
      });
    }
    const job = await pending;
    const manifest = await readManifest(job.snapshot);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...job,
            manifest,
            progress: `Read ${job.snapshot}/manifest.json or call export_data again while running. Resume after interruption with the snapshot folder name.`,
          }),
        },
      ],
    };
  },
});

const startJob = async (options: DataExportOptions, key: string): Promise<Job> => {
  const prepared = await prepareDataExport(options);
  const job: Job = { snapshot: prepared.snapshot, running: true };
  // Queue after preparation; callers get a reserved snapshot and durable manifest.
  void prepared
    .run()
    .catch((err: unknown) => {
      job.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      job.running = false;
      jobs.delete(key);
    });
  return job;
};
