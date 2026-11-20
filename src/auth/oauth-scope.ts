/**
 * The OAuth scope requested at sign-in. `--read-only` asks for `read` so that
 * Zendesk itself refuses every write made with the token, whatever the tool
 * surface: the tool filter alone only guards the writes this server knows about.
 *
 * Each mode also asks for the side-conversations scope it needs: the Side
 * Conversations API reference lists `side_conversations:read` and
 * `side_conversations:write` as the scopes its endpoints accept, and a token
 * granted only `read` gets a 403 there.
 */
export type OAuthScope =
  | 'read side_conversations:read'
  | 'read write side_conversations:read side_conversations:write';

/** The resource scope a token needs to read side conversations. */
export const SIDE_CONVERSATIONS_READ = 'side_conversations:read';

export const requestedScope = (readOnly: boolean): OAuthScope =>
  readOnly
    ? 'read side_conversations:read'
    : 'read write side_conversations:read side_conversations:write';

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

/**
 * Whether a space-separated granted scope lists `entry`. No trim: the empty
 * entries that surrounding whitespace leaves never equal a real scope name.
 */
export const grantsScope = (scope: string, entry: string): boolean =>
  scope.split(WHITESPACE).includes(entry);
