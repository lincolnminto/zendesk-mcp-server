// Zendesk Basic auth expects the username as "{email}/token", not the bare email.
export const buildBasicAuthHeader = (email: string, apiToken: string): string =>
  `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString('base64')}`;
