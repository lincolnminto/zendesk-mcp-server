import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildBasicAuthHeader } from './auth/api-token';
import { createTokenStore } from './auth/token-store';
import type { Config } from './config';
import { loadConfig } from './config';
import { startDevServer } from './dev/reload';
import { createMcpServer } from './server';
import { startHttpTransport } from './transports/http';
import { startStdioTransport } from './transports/stdio';
import { createLogger, type Logger } from './utils/logger';
import { installShutdown } from './utils/shutdown';

// What connectStdio needs, regardless of which auth mode produced it. No
// `invalidate` in API-token mode: a stale static token is a credential
// rotation problem, not something the server can recover from at runtime.
interface StdioTokenSource {
  getToken: () => string | Promise<string>;
  invalidate?: () => void;
  dispose: () => void;
}

// OAuth mode — browser-based auth on first tool call. `invalidate` drops the
// dead access token on a 401 so the next call refreshes/re-authenticates.
const buildOAuthTokenSource = (config: Config, logger: Logger): StdioTokenSource =>
  createTokenStore(
    {
      subdomain: config.subdomain,
      oauthClientId: config.oauthClientId,
      callbackPort: config.callbackPort,
    },
    logger,
  );

// stdio auto-detects the auth mode: API token (static Basic auth) when both
// ZENDESK_EMAIL and ZENDESK_API_TOKEN are set — a headless/CI escape hatch,
// see docs/api-token-stdio.md — OAuth 2.1 PKCE otherwise.
const buildStdioTokenSource = (config: Config, logger: Logger): StdioTokenSource => {
  if (config.zendeskEmail && config.zendeskApiToken) {
    const staticToken = buildBasicAuthHeader(config.zendeskEmail, config.zendeskApiToken);
    return { getToken: () => staticToken, dispose: () => undefined };
  }
  return buildOAuthTokenSource(config, logger);
};

// Both stdio paths end with a server already connected to its transport; dev
// mode wires `reload_tools` and connects on its own. Returning the server is
// what lets the caller close it on shutdown.
const connectStdio = async (
  config: Config,
  tokenSource: StdioTokenSource,
  logger: Logger,
): Promise<McpServer> => {
  if (config.dev) {
    return startDevServer(config, tokenSource.getToken, logger, tokenSource.invalidate);
  }
  const server = createMcpServer(config, tokenSource.getToken, logger, tokenSource.invalidate);
  await startStdioTransport(server, logger);
  return server;
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.transport === 'stdio') {
    const tokenSource = buildStdioTokenSource(config, logger);
    const server = await connectStdio(config, tokenSource, logger);

    // Installed *after* the transport is connected: the SDK's stdin `data`
    // listener is what puts stdin in flowing mode, and `end` only fires there.
    installShutdown({
      watchStdin: true,
      logger,
      cleanup: async () => {
        await server.close();
        tokenSource.dispose();
      },
    });
    return;
  }

  if (config.dev) {
    // Dev mode hot-reloads a single long-lived server; HTTP builds one per
    // request, so there is nothing to reload. Warn rather than silently ignore.
    logger.warn('dev_mode_ignored_http');
  }

  // HTTP mode: the HTTP transport creates a per-session McpServer with the
  // request's bearer captured in its tools' closure — no shared state.
  const http = await startHttpTransport(config, logger);

  // Signals only: an HTTP server has no client on stdin to lose. Nothing reads
  // stdin here, so it stays paused and never reports EOF anyway — but saying so
  // explicitly keeps that from becoming load-bearing.
  installShutdown({ watchStdin: false, logger, cleanup: http.close });
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
