import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/utils/logger';

interface TokenResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

// The browser flow is mocked: these tests drive what Zendesk grants and assert
// what the command asks for, writes and prints. The token file is real, in a
// temporary config dir.
const startBrowserAuthMock =
  vi.fn<
    (
      config: Record<string, unknown>,
      logger: Logger,
    ) => Promise<{ authorizeUrl: string; tokenPromise: Promise<TokenResult> }>
  >();

vi.mock('../../../src/auth/browser-oauth', () => ({
  startBrowserAuth: (config: Record<string, unknown>, logger: Logger) =>
    startBrowserAuthMock(config, logger),
  refreshAccessToken: () => Promise.reject(new Error('not used')),
}));

const { login, parseLoginArgs, runLoginCli } = await import('../../../src/auth/login');

const RW_SCOPE = 'read write side_conversations:read side_conversations:write';
const RO_SCOPE = 'read side_conversations:read';
const USAGE =
  'Usage: zendesk-mcp-server login <subdomain> [--read-only] [--callback-port <port>] [--log-level <debug|info|warn|error>]';
const CONFIG_ENV = [
  'ZENDESK_SUBDOMAIN',
  'ZENDESK_OAUTH_CLIENT_ID',
  'ZENDESK_EMAIL',
  'ZENDESK_API_TOKEN',
  'ZENDESK_TOKEN_FILE',
  'LOG_LEVEL',
  'TRANSPORT',
  'HOST',
  'PORT',
  'ZENDESK_OAUTH_CALLBACK_PORT',
  'HC_RESOURCE_SCHEME',
  'ZENDESK_EXPORT_DIR',
];

const granting = (token: TokenResult) =>
  startBrowserAuthMock.mockResolvedValue({
    authorizeUrl: 'https://acme.zendesk.com/oauth/authorizations/new',
    tokenPromise: Promise.resolve(token),
  });

const caught = (run: () => unknown): Error => {
  try {
    run();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a throw');
};

let configHome: string;
const tokenDir = () => join(configHome, 'lincolnminto', 'zendesk-mcp-server');
const readRecord = async (file: string) =>
  JSON.parse(await readFile(join(tokenDir(), file), 'utf8')) as unknown;

beforeEach(async () => {
  startBrowserAuthMock.mockReset();
  for (const name of CONFIG_ENV) vi.stubEnv(name, undefined);
  configHome = await mkdtemp(join(tmpdir(), 'login-'));
  vi.stubEnv('XDG_CONFIG_HOME', configHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseLoginArgs', () => {
  it('builds the server config for the subdomain, read-write by default', () => {
    expect(parseLoginArgs(['acme'])).toMatchObject({
      subdomain: 'acme',
      oauthClientId: 'acme_zendesk',
      readOnly: false,
      callbackPort: undefined,
      logLevel: 'info',
    });
  });

  it('passes the read-only, callback port and log level flags through', () => {
    expect(
      parseLoginArgs(['acme', '--read-only', '--callback-port', '28000', '--log-level', 'warn']),
    ).toMatchObject({ subdomain: 'acme', readOnly: true, callbackPort: 28000, logLevel: 'warn' });
  });

  it('uses the OAuth client and callback port the server reads from the environment', () => {
    vi.stubEnv('ZENDESK_OAUTH_CLIENT_ID', 'custom_client');
    vi.stubEnv('ZENDESK_OAUTH_CALLBACK_PORT', '28001');
    expect(parseLoginArgs(['acme'])).toMatchObject({
      oauthClientId: 'custom_client',
      callbackPort: 28001,
    });
  });

  it.each([[[]], [['acme', 'extra']], [['']]])('rejects %j with the usage line', (args) => {
    expect(() => parseLoginArgs(args)).toThrow(new Error(USAGE));
  });

  it('rejects a flag the login does not take, keeping the parser error as the cause', () => {
    const err = caught(() => parseLoginArgs(['acme', '--mode', 'all']));
    expect(err.message).toBe(USAGE);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('rejects a value on the read-only switch', () => {
    expect(() => parseLoginArgs(['acme', '--read-only=yes'])).toThrow(new Error(USAGE));
  });
});

describe('login', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const base = { subdomain: 'acme', oauthClientId: 'acme_zendesk', callbackPort: 28000 };

  it('signs in read-only with the side-conversations read scope and saves the read token file', async () => {
    granting({ access_token: 'ro-access', refresh_token: 'ro-refresh', scope: RO_SCOPE });

    const result = await login({ ...base, readOnly: true }, logger);

    expect(startBrowserAuthMock).toHaveBeenCalledWith(
      { subdomain: 'acme', oauthClientId: 'acme_zendesk', callbackPort: 28000, scope: RO_SCOPE },
      logger,
    );
    expect(result).toEqual({ tokenPath: join(tokenDir(), 'acme.read.json'), scope: RO_SCOPE });
    expect(await readRecord('acme.read.json')).toEqual({
      accessToken: 'ro-access',
      refreshToken: 'ro-refresh',
      scope: RO_SCOPE,
    });
  });

  it('signs in read-write with both side-conversations scopes and saves the read-write token file', async () => {
    granting({ access_token: 'rw-access', scope: RW_SCOPE });

    const result = await login({ ...base, readOnly: false });

    expect(startBrowserAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: RW_SCOPE }),
      expect.anything(),
    );
    expect(result).toEqual({ tokenPath: join(tokenDir(), 'acme.json'), scope: RW_SCOPE });
    expect(await readRecord('acme.json')).toEqual({ accessToken: 'rw-access', scope: RW_SCOPE });
  });

  it('replaces a token that still works, so an old grant gains the new scope', async () => {
    mkdirSync(tokenDir(), { recursive: true });
    await writeFile(
      join(tokenDir(), 'acme.read.json'),
      JSON.stringify({ accessToken: 'old', refreshToken: 'old-refresh', scope: 'read' }),
    );
    granting({ access_token: 'new', refresh_token: 'new-refresh', scope: RO_SCOPE });

    await login({ ...base, readOnly: true });

    expect(await readRecord('acme.read.json')).toEqual({
      accessToken: 'new',
      refreshToken: 'new-refresh',
      scope: RO_SCOPE,
    });
  });

  it('records the scope Zendesk granted, not the one requested', async () => {
    granting({ access_token: 'narrow', scope: 'read' });

    await expect(login({ ...base, readOnly: true })).resolves.toMatchObject({ scope: 'read' });
    expect(await readRecord('acme.read.json')).toMatchObject({ scope: 'read' });
  });

  it('takes a response without a scope as granting the requested one (RFC 6749 s5.1)', async () => {
    granting({ access_token: 'implicit' });

    await expect(login({ ...base, readOnly: true })).resolves.toMatchObject({ scope: RO_SCOPE });
    expect(await readRecord('acme.read.json')).toMatchObject({ scope: RO_SCOPE });
  });

  it('records the absolute expiry of an expiring token', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    granting({ access_token: 'expiring', expires_in: 3600, scope: RW_SCOPE });

    await login({ ...base, readOnly: false });

    expect(await readRecord('acme.json')).toEqual({
      accessToken: 'expiring',
      expiresAt: 1_000_000 + 3_600_000,
      scope: RW_SCOPE,
    });
  });

  it('refuses a read-only grant that can write, and saves nothing', async () => {
    granting({ access_token: 'too-broad', scope: 'read write' });

    await expect(login({ ...base, readOnly: true })).rejects.toThrow(
      new Error('Zendesk granted a scope broader than read (read write); nothing was saved.'),
    );
    await expect(readRecord('acme.read.json')).rejects.toThrow('ENOENT');
  });

  it('saves a read-write grant even without the side-conversations scopes', async () => {
    granting({ access_token: 'legacy-shape', scope: 'read write' });

    await expect(login({ ...base, readOnly: false })).resolves.toMatchObject({
      scope: 'read write',
    });
  });

  it('saves nothing when the browser flow fails', async () => {
    startBrowserAuthMock.mockResolvedValue({
      authorizeUrl: 'https://acme.zendesk.com/oauth/authorizations/new',
      tokenPromise: Promise.reject(new Error('OAuth error: access_denied')),
    });

    await expect(login({ ...base, readOnly: false })).rejects.toThrow('access_denied');
    await expect(readRecord('acme.json')).rejects.toThrow('ENOENT');
  });
});

describe('runLoginCli', () => {
  it('prints where the token went and the granted scope, never the token', async () => {
    granting({ access_token: 'secret-access', refresh_token: 'secret-refresh', scope: RO_SCOPE });
    const lines: string[] = [];

    const code = await runLoginCli(['acme', '--read-only', '--log-level', 'error'], (line) =>
      lines.push(line),
    );

    expect(code).toBe(0);
    expect(lines).toEqual([
      `Signed in to acme. Token saved to ${join(tokenDir(), 'acme.read.json')}`,
      `Granted scope: ${RO_SCOPE}`,
    ]);
    expect(lines.join('\n')).not.toMatch(/secret/);
    expect(startBrowserAuthMock).toHaveBeenCalledWith(
      {
        subdomain: 'acme',
        oauthClientId: 'acme_zendesk',
        callbackPort: undefined,
        scope: RO_SCOPE,
      },
      expect.anything(),
    );
  });

  it('warns when Zendesk did not grant the side-conversations read scope', async () => {
    granting({ access_token: 'narrow', scope: 'read write' });
    const lines: string[] = [];

    await runLoginCli(['acme', '--log-level', 'error'], (line) => lines.push(line));

    expect(lines).toEqual([
      `Signed in to acme. Token saved to ${join(tokenDir(), 'acme.json')}`,
      'Granted scope: read write',
      'Zendesk did not grant side_conversations:read: side conversation requests will be refused (HTTP 403).',
    ]);
  });

  it('prints to stdout by default', async () => {
    granting({ access_token: 'a', scope: RW_SCOPE });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runLoginCli(['acme', '--log-level', 'error']);

    expect(log).toHaveBeenCalledWith(`Granted scope: ${RW_SCOPE}`);
  });

  it('notes on stderr that a configured API token takes precedence over the sign-in', async () => {
    vi.stubEnv('ZENDESK_EMAIL', 'agent@example.com');
    vi.stubEnv('ZENDESK_API_TOKEN', 'not-a-real-token');
    granting({ access_token: 'a', scope: RW_SCOPE });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runLoginCli(['acme', '--log-level', 'error'], () => undefined);

    expect(error).toHaveBeenCalledWith(
      'ZENDESK_EMAIL and ZENDESK_API_TOKEN are set: the server and export-data use that API token, not this sign-in, until they are unset.',
    );
  });

  it.each([
    ['only the email', 'ZENDESK_EMAIL'],
    ['only the API token', 'ZENDESK_API_TOKEN'],
  ])('does not note an API token when %s is set', async (_label, name) => {
    vi.stubEnv(name, 'value');
    granting({ access_token: 'a', scope: RW_SCOPE });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runLoginCli(['acme', '--log-level', 'error'], () => undefined);

    expect(error).not.toHaveBeenCalled();
  });
});
