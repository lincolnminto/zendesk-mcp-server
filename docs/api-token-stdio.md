# API token authentication (stdio only)

This is the escape hatch for **CI / headless** contexts where a browser OAuth flow is impossible. For every other context — laptops, desktops, remote servers — prefer the OAuth flows in the [README quick-start sections](../README.md#quick-start-local-stdio).

## Why it's stdio-only

A Zendesk API token grants the **issuing user's full rights** to anyone holding it. In HTTP mode this would expose every caller to the same permissions, which is exactly the anti-pattern the per-user OAuth design was built to avoid. The server refuses API-token credentials at boot in HTTP mode.

In stdio mode the credentials never leave the local machine, so an API token is a reasonable escape hatch. Why this mode exists again after being deliberately removed, and what stays off the table: [`docs/decisions/api-token-auth.md`](decisions/api-token-auth.md).

## Setup

1. **Admin Center → Apps and integrations → APIs → Zendesk API** → enable **Token Access** and create a token.
2. Invoke the binary with the credentials in the environment:

   ```bash
   ZENDESK_EMAIL=you@example.com ZENDESK_API_TOKEN=dneib123... \
     zendesk-mcp-server <your-subdomain> --mode single
   ```

If both `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN` are set when stdio starts, the server uses API token authentication. Otherwise it uses OAuth 2.1 PKCE (the recommended path). Setting only one of the two is treated as a harmless stray variable, not an error — it falls back to OAuth.

To wire these into an MCP client's config instead of invoking the binary by hand, add them as an `env` block (Claude Desktop, VS Code) or via `-e` (Claude Code): see [MCP client wiring](../README.md#mcp-client-wiring) in the README, which shows both the OAuth and the API-token form per client.
