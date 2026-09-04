# API-token auth: reopening the OAuth-only decision for a stdio escape hatch

> **Build documentation, not user documentation.** This records why static
> API-token authentication came back after being deliberately removed, and why
> that removal's reasoning still holds everywhere except stdio. Client-facing
> setup lives in [`docs/api-token-stdio.md`](../api-token-stdio.md).

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-09-04 |
| **Question** | Should the server support Zendesk API-token (Basic auth) authentication again, after PR #84 removed it in favor of OAuth 2.1 PKCE only? |
| **Answer** | **Yes, but only in stdio.** A real headless/CI use case exists now; HTTP keeps refusing API-token config at boot, unchanged from #84. |

## Why #84 removed it, and why that reasoning only partly applies now

PR #84 dropped the mode for three reasons: it added confusion from having two
auth paths, it wasn't differentiating (other Zendesk MCP servers already cover
API tokens), and — the deciding one — nobody was actually using it (no
`ZENDESK_API_TOKEN` configured anywhere at the time).

The security argument from #84 is untouched by this decision and still governs
HTTP: a Zendesk API token is a long-lived, static secret carrying the full
rights of whoever issued it, with no per-user scoping, no short expiry, and no
per-user revocation. Over HTTP that would expose one issuer's rights to every
caller of what may be a multi-user remote deployment — exactly the anti-pattern
the OAuth model exists to avoid. That risk does not exist for stdio: a stdio
server is one local process, for one operator, with no second caller to expose
rights to.

What changed is the "nobody uses it" premise: there is now a concrete headless
automation / CI use case where the OAuth browser flow cannot run at all, and
re-adding the mode is the only way to authenticate in that context.

## What was restored, and what stays off the table

- **stdio auto-detects the mode.** Both `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN`
  set → Basic auth (`src/auth/api-token.ts`); otherwise → OAuth. A single stray
  variable is silently ignored rather than erroring — rejecting a lone
  `ZENDESK_EMAIL` left over in a shell profile would surprise an operator who
  meant to use OAuth. This matches the original (pre-#84) behavior exactly.
- **HTTP still refuses it at boot** when both variables are set — the same
  guard #84 added, kept as-is, because the security argument above still holds
  there. This is not reopened.
- **No new selection flag.** Auto-detection by env-var presence was the
  original design and is kept as-is; an explicit `--auth-mode` flag was
  considered and rejected as unneeded ceremony for a two-variable presence
  check that only ever matters in stdio.

## What would reverse this

If the OAuth flow ever gains a genuinely headless variant (a device-code-style
flow, if Zendesk added one), the motivating use case disappears and this mode
could be dropped again — this time without "nobody uses it" being the only
thing propping the decision up.
