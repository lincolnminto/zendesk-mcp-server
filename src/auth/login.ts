import { parseArgs } from 'node:util';
import { type Config, loadConfig } from '../config';
import { createLogger, type Logger, silentLogger } from '../utils/logger';
import { startBrowserAuth } from './browser-oauth';
import {
  grantsScope,
  isReadOnlyScope,
  requestedScope,
  SIDE_CONVERSATIONS_READ,
} from './oauth-scope';
import { resolveTokenPath, writeFileAtomic } from './token-persistence';
import { expiryFrom } from './token-store';

const LOGIN_USAGE =
  'Usage: zendesk-mcp-server login <subdomain> [--read-only] [--callback-port <port>] [--log-level <debug|info|warn|error>]';

/**
 * Parse `login` arguments into the same `Config` the server builds, so the
 * OAuth client, callback port and token file are the ones the server uses for
 * that mode. Only the flags that bear on signing in are accepted.
 */
export const parseLoginArgs = (args: string[]): Config => {
  let parsed: ReturnType<typeof parseLoginOptions>;
  try {
    parsed = parseLoginOptions(args);
  } catch (err) {
    throw new Error(LOGIN_USAGE, { cause: err });
  }
  const { values, positionals } = parsed;
  const [subdomain] = positionals;
  if (positionals.length !== 1 || !subdomain) throw new Error(LOGIN_USAGE);
  const flag = (name: 'callback-port' | 'log-level'): string[] => {
    const value = values[name];
    return value === undefined ? [] : [`--${name}`, value];
  };
  return loadConfig([
    subdomain,
    ...(values['read-only'] ? ['--read-only'] : []),
    ...flag('callback-port'),
    ...flag('log-level'),
  ]);
};

const parseLoginOptions = (args: string[]) =>
  parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      'read-only': { type: 'boolean' },
      'callback-port': { type: 'string' },
      'log-level': { type: 'string' },
    },
  });

export interface LoginResult {
  tokenPath: string;
  scope: string;
}

/**
 * Run the browser OAuth flow with the scope the server now requests and
 * replace the stored token for that mode. Unlike the server's lazy sign-in,
 * this always signs in, even over a working token: it is how a token granted
 * before a scope was added gets that scope.
 */
export const login = async (
  config: Pick<Config, 'subdomain' | 'oauthClientId' | 'callbackPort' | 'readOnly'>,
  logger: Logger = silentLogger,
): Promise<LoginResult> => {
  const scope = requestedScope(config.readOnly);
  const started = await startBrowserAuth(
    {
      subdomain: config.subdomain,
      oauthClientId: config.oauthClientId,
      callbackPort: config.callbackPort,
      scope,
    },
    logger,
  );
  const result = await started.tokenPromise;
  // A token response that omits the scope was granted the one requested (RFC 6749 s5.1).
  const granted = result.scope ?? scope;
  // Same guard as the server's sign-in: a read-only token file never holds a
  // grant that can write, whatever the authorization server returned.
  if (config.readOnly && !isReadOnlyScope(granted)) {
    throw new Error(`Zendesk granted a scope broader than read (${granted}); nothing was saved.`);
  }
  const tokenPath = resolveTokenPath(config.subdomain, { readOnly: config.readOnly });
  writeFileAtomic(tokenPath, {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: expiryFrom(result.expires_in),
    scope: granted,
  });
  return { tokenPath, scope: granted };
};

/**
 * `zendesk-mcp-server login <subdomain> [--read-only]`. Prints where the token
 * was saved and the scope Zendesk granted; never the token itself.
 */
export const runLoginCli = async (
  args: string[],
  print: (line: string) => void = (line) => console.log(line),
): Promise<number> => {
  const config = parseLoginArgs(args);
  if (config.zendeskEmail && config.zendeskApiToken) {
    console.error(
      'ZENDESK_EMAIL and ZENDESK_API_TOKEN are set: the server and export-data use that API token, not this sign-in, until they are unset.',
    );
  }
  const { tokenPath, scope } = await login(config, createLogger(config.logLevel));
  print(`Signed in to ${config.subdomain}. Token saved to ${tokenPath}`);
  print(`Granted scope: ${scope}`);
  if (!grantsScope(scope, SIDE_CONVERSATIONS_READ)) {
    print(
      `Zendesk did not grant ${SIDE_CONVERSATIONS_READ}: side conversation requests will be refused (HTTP 403).`,
    );
  }
  return 0;
};
