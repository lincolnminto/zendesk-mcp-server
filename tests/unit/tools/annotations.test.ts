import { describe, expect, it } from 'vitest';
import { createAllTools, type ToolContext } from '../../../src/tools';

// exportDir: the full surface, admin export included (it is opt-in).
const ctx: ToolContext = {
  subdomain: 'testsubdomain',
  getToken: () => 'test-token',
  exportDir: '/exports',
};
const tools = createAllTools(ctx);

// Read only from Zendesk, so --read-only keeps them (`readOnly`), but they write
// on the caller's machine, so `readOnlyHint` is honestly false. Still never
// destructive: what they write is always new.
const LOCAL_WRITERS: ReadonlySet<string> = new Set(['export_account_config']);

describe('tool annotation invariants', () => {
  it('every tool: readOnly matches annotations.readOnlyHint, except local writers', () => {
    const violations = tools
      .filter((t) => !LOCAL_WRITERS.has(t.name) && t.annotations.readOnlyHint !== t.readOnly)
      .map((t) => t.name);
    expect(violations).toEqual([]);
  });

  it('local writers: Zendesk-read-only, readOnlyHint false, never destructive', () => {
    const writers = tools.filter((t) => LOCAL_WRITERS.has(t.name));
    expect(writers.map((t) => t.name)).toEqual([...LOCAL_WRITERS]);
    for (const t of writers) {
      expect(t.readOnly).toBe(true);
      expect(t.annotations.readOnlyHint).toBe(false);
      expect(t.annotations.destructiveHint).toBe(false);
    }
  });

  it('every tool: a read-only tool cannot be destructive', () => {
    const violations = tools
      .filter((t) => t.readOnly && t.annotations.destructiveHint)
      .map((t) => t.name);
    expect(violations).toEqual([]);
  });

  it('every tool: openWorldHint=true (this server always hits Zendesk)', () => {
    const violations = tools.filter((t) => !t.annotations.openWorldHint).map((t) => t.name);
    expect(violations).toEqual([]);
  });
});
