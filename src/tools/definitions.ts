import type * as z from 'zod/v4';
import type { Namespace } from '../config';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolTextContent {
  type: 'text';
  text: string;
}
export interface ToolImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<ToolTextContent | ToolImageContent>;
}

export interface ToolDefinition {
  name: string;
  namespace: Namespace;
  readOnly: boolean;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolContext {
  subdomain: string;
  getToken: () => string | Promise<string>;
  /**
   * Whether a tool may read a file from a path the caller names (the comment
   * tools' `attachment_paths`). True only over stdio, where the server runs on
   * the caller's machine. Over HTTP the path would resolve on the server host,
   * handing every remote caller the server's files, so absent means refused.
   */
  localFileAccess?: boolean;
  /**
   * Operator-configured directory for `export_account_config` snapshots
   * (`--export-dir`); the admin namespace exists only when it is set. stdio
   * only: config refuses it over HTTP.
   */
  exportDir?: string | undefined;
}
