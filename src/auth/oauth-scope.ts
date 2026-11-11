/**
 * The OAuth scope requested at sign-in. `--read-only` asks for `read` so that
 * Zendesk itself refuses every write made with the token, whatever the tool
 * surface: the tool filter alone only guards the writes this server knows about.
 */
export type OAuthScope = 'read' | 'read write';

export const requestedScope = (readOnly: boolean): OAuthScope => (readOnly ? 'read' : 'read write');

// Zendesk scopes are space-separated: the global `read` / `write`, resource
// scopes such as `tickets:read` / `users:write`, and `impersonate`. A grant is
// read-only only when every entry is a read; an unknown (unrecorded) scope is
// not, so a token persisted before scopes were recorded never passes.
const READ_ENTRY = /^(?:read|[a-z_]+:read)$/;
const WHITESPACE = /\s+/;

// `unknown`, not `string | undefined`: the scope comes back from a token file,
// where garbage must read as "not read-only" rather than crash the boot.
export const isReadOnlyScope = (scope: unknown): boolean =>
  typeof scope === 'string' &&
  scope
    .trim()
    .split(WHITESPACE)
    .every((entry) => READ_ENTRY.test(entry));
