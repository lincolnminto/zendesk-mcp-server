import * as z from 'zod/v4';
import type { ToolContext, ToolDefinition } from '../tools/definitions';
import { GOLDEN_STAGES, type GoldenStage, prepareGoldens } from './goldens';
import { readManifest } from './ndjson';
import { backgroundJob } from './tool';

export const createGoldensTool = (ctx: ToolContext, exportDir: string): ToolDefinition => ({
  name: 'record_goldens',
  namespace: 'admin',
  readOnly: true,
  title: 'Record Zendesk Golden Observations',
  description:
    'Record read-only golden master observations of Zendesk views, macro previews, SLAs, audits and search in local files in the background. ' +
    'Use after export_data to characterize current Zendesk behavior for replacement-system tests; use export_data for the underlying data snapshot and interactive tools for ticket work. ' +
    'Requires an admin sign-in and an operator-configured export directory on a stdio server. Only GET requests reach Zendesk; macro previews do not apply changes. Creates a new timestamped local folder containing potentially sensitive ticket, user and query data. ' +
    'Returns the snapshot path and manifest progress immediately. Call again while running to poll the same account/export-directory job, shared with export_data. The job stops when the server exits; resume skips done stages and already recorded views/macros. Read manifest.json and item indexes for errors, skipped items and progress.',
  inputSchema: z.object({
    data_snapshot: z
      .string()
      .min(1)
      .describe(
        'Required data snapshot folder name produced by export_data, inside the configured export directory. No separators or .. allowed. Latest ticket versions determine samples and generated searches.',
      ),
    stages: z
      .array(z.enum(GOLDEN_STAGES))
      .min(1)
      .optional()
      .describe(
        'Observation stages to record, for example ["views", "macros"]. Omit for context, views, macros, slas and search in order. Resume may select only originally selected stages.',
      ),
    resume: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Existing golden snapshot folder name inside the configured export directory, without separators or double dots. Skips done stages and written view/macro files; requires the same data snapshot and recording user.',
      ),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (params) => {
    const values = params as { data_snapshot: string; stages?: GoldenStage[]; resume?: string };
    const job = await backgroundJob(ctx, exportDir, () =>
      prepareGoldens({
        subdomain: ctx.subdomain,
        getToken: ctx.getToken,
        exportDir,
        dataSnapshot: values.data_snapshot,
        ...(values.stages ? { stages: values.stages } : {}),
        ...(values.resume !== undefined ? { resume: values.resume } : {}),
      }),
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...job,
            manifest: await readManifest(job.snapshot),
            progress: `Read ${job.snapshot}/manifest.json or call record_goldens again while running. Resume with the snapshot folder name and original data_snapshot.`,
          }),
        },
      ],
    };
  },
});
