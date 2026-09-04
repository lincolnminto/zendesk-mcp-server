# Zendesk MCP Server

An MCP server that exposes Zendesk Support and Help Center (Guide) operations
as tools, shaped around what an LLM needs rather than mirroring the Zendesk API.

## Language

**Auth mode**:
Which credential scheme a running server instance uses against Zendesk: OAuth mode or API-token mode. Selected automatically per transport and environment, never by an explicit flag.
_Avoid_: auth flavor, auth method

**OAuth mode**:
The default auth mode, in both transports: a per-user OAuth 2.1 PKCE access token, scoped to exactly what that Zendesk user can do.
_Avoid_: browser mode

**API-token mode**:
The stdio-only auth mode: Zendesk Basic auth (a static API token paired with the issuing user's email), used as a headless/CI escape hatch when the OAuth browser flow cannot run. Never available over HTTP.
_Avoid_: service-account mode, shared-token mode — the token still belongs to one issuing Zendesk user, never a shared account

**Operator**:
The person who deploys and configures a running server instance: chooses flags, env vars, and which auth modes are even reachable. Distinct from the Zendesk end user, who is who the server acts as once authenticated (via OAuth sign-in, an HTTP bearer, or an API token) — in stdio they are usually the same person; in a remote HTTP deployment they are not.
_Avoid_: user (ambiguous between the operator and the authenticated Zendesk end user)
