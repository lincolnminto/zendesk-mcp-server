import { describe, expect, it } from 'vitest';
import {
  grantsScope,
  isReadOnlyScope,
  requestedScope,
  SIDE_CONVERSATIONS_READ,
} from '../../../src/auth/oauth-scope';

describe('requestedScope', () => {
  it('asks for read and write, side conversations included, by default', () => {
    expect(requestedScope(false)).toBe(
      'read write side_conversations:read side_conversations:write',
    );
  });

  it('asks for read only, side conversations included, in read-only mode', () => {
    expect(requestedScope(true)).toBe('read side_conversations:read');
  });

  it('asks a read-only sign-in for a scope the read-only guard accepts', () => {
    expect(isReadOnlyScope(requestedScope(true))).toBe(true);
    expect(isReadOnlyScope(requestedScope(false))).toBe(false);
  });
});

describe('grantsScope', () => {
  it('names the side-conversations read scope', () => {
    expect(SIDE_CONVERSATIONS_READ).toBe('side_conversations:read');
  });

  it.each([
    ['read side_conversations:read'],
    ['side_conversations:read'],
    ['read  side_conversations:read write'],
    [' side_conversations:read '],
  ])('finds the entry in %j', (scope) => {
    expect(grantsScope(scope, SIDE_CONVERSATIONS_READ)).toBe(true);
  });

  it.each([
    ['read'],
    ['read write'],
    ['side_conversations:write'],
    ['side_conversations:readonly'],
    ['xside_conversations:read'],
    [''],
  ])('does not find the entry in %j', (scope) => {
    expect(grantsScope(scope, SIDE_CONVERSATIONS_READ)).toBe(false);
  });
});

describe('isReadOnlyScope', () => {
  it.each([
    ['read'],
    ['read side_conversations:read'],
    ['tickets:read'],
    ['tickets:read users:read'],
    ['tickets:read  users:read'],
    ['  read  '],
  ])('accepts %j', (scope) => {
    expect(isReadOnlyScope(scope)).toBe(true);
  });

  it.each([
    ['read write'],
    ['read write side_conversations:read side_conversations:write'],
    ['read side_conversations:write'],
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
