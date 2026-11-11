import { describe, expect, it } from 'vitest';
import { isReadOnlyScope, requestedScope } from '../../../src/auth/oauth-scope';

describe('requestedScope', () => {
  it('asks for read and write by default', () => {
    expect(requestedScope(false)).toBe('read write');
  });

  it('asks for read only in read-only mode', () => {
    expect(requestedScope(true)).toBe('read');
  });
});

describe('isReadOnlyScope', () => {
  it.each([
    ['read'],
    ['tickets:read'],
    ['tickets:read users:read'],
    ['tickets:read  users:read'],
    ['  read  '],
  ])('accepts %j', (scope) => {
    expect(isReadOnlyScope(scope)).toBe(true);
  });

  it.each([
    ['read write'],
    ['write'],
    ['tickets:read tickets:write'],
    ['read impersonate'],
    ['readwrite'],
    ['unread'],
    ['tickets:write:read'],
    [''],
    ['   '],
  ])('rejects %j', (scope) => {
    expect(isReadOnlyScope(scope)).toBe(false);
  });

  it('rejects an unknown scope (a token persisted before scopes were recorded)', () => {
    expect(isReadOnlyScope(undefined)).toBe(false);
  });

  it.each([[42], [['read']], [{ read: true }], [null]])(
    'rejects a malformed scope from disk (%j) without throwing',
    (scope) => {
      expect(isReadOnlyScope(scope)).toBe(false);
    },
  );
});
