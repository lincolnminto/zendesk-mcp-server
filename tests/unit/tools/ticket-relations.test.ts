import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { filterTools } from '../../../src/routing/registry';
import type { ToolContext } from '../../../src/tools/definitions';
import { createAllTools } from '../../../src/tools/index';
import { createTicketRelationTools } from '../../../src/tools/ticket-relations';
import { MOCK_TICKET } from '../../msw-handlers';
import { mswServer } from '../../setup';

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };

// Serve one Show Ticket response, merged over MOCK_TICKET, for the next call.
const serveTicket = (fields: Record<string, unknown>): void => {
  mswServer.use(
    http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id', ({ params }) =>
      HttpResponse.json({ ticket: { ...MOCK_TICKET, id: Number(params['id']), ...fields } }),
    ),
  );
};

describe('ticket relation tools', () => {
  it('creates 1 tool', () => {
    expect(createTicketRelationTools(ctx)).toHaveLength(1);
  });

  describe('get_ticket_relations', () => {
    const [tool] = createTicketRelationTools(ctx);
    if (!tool) throw new Error('get_ticket_relations tool not registered');

    const relationsOf = async (ticket_id: number): Promise<string> =>
      (await tool.handler({ ticket_id })).content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');

    it('names the closed ticket a follow-up continues, with its subject', async () => {
      // A follow-up carries via.source.rel "follow_up" and, in `from`, the closed
      // ticket it was created from (Via object reference).
      serveTicket({
        via: {
          channel: 'closed_ticket',
          source: { from: { ticket_id: 1, subject: 'Printer on fire' }, to: {}, rel: 'follow_up' },
        },
      });
      expect(await relationsOf(2)).toMatchInlineSnapshot(`
        "# Relationships of ticket #2
        - **Follow-up of**: #1 (Printer on fire) — the closed ticket this one continues"
      `);
    });

    it('names the follow-up source by id alone when Zendesk sends no subject', async () => {
      serveTicket({
        via: { channel: 'web_service', source: { from: { ticket_id: 1 }, rel: 'follow_up' } },
      });
      expect(await relationsOf(2)).toMatchInlineSnapshot(`
        "# Relationships of ticket #2
        - **Follow-up of**: #1 — the closed ticket this one continues"
      `);
    });

    it('lists the follow-ups created from a closed ticket', async () => {
      serveTicket({ status: 'closed', followup_ids: [2, 3] });
      expect(await relationsOf(1)).toMatchInlineSnapshot(`
        "# Relationships of ticket #1
        - **Follow-ups**: #2, #3 — tickets created from this one after it closed"
      `);
    });

    it('links an incident to its problem ticket', async () => {
      serveTicket({ type: 'incident', problem_id: 42 });
      expect(await relationsOf(7)).toMatchInlineSnapshot(`
        "# Relationships of ticket #7
        - **Problem**: #42 — the problem ticket this incident is linked to"
      `);
    });

    it('points a problem ticket to get_linked_incidents for its incidents', async () => {
      serveTicket({ type: 'problem', problem_id: null });
      expect(await relationsOf(42)).toMatchInlineSnapshot(`
        "# Relationships of ticket #42
        - **Incidents**: this is a problem ticket; list the incidents linked to it with get_linked_incidents (problem_id: 42)"
      `);
    });

    it('renders every relationship the ticket carries, one line each', async () => {
      serveTicket({
        status: 'closed',
        type: 'problem',
        followup_ids: [9],
        via: {
          channel: 'closed_ticket',
          source: { from: { ticket_id: 1, subject: 'Printer on fire' }, rel: 'follow_up' },
        },
      });
      expect(await relationsOf(5)).toMatchInlineSnapshot(`
        "# Relationships of ticket #5
        - **Follow-up of**: #1 (Printer on fire) — the closed ticket this one continues
        - **Follow-ups**: #9 — tickets created from this one after it closed
        - **Incidents**: this is a problem ticket; list the incidents linked to it with get_linked_incidents (problem_id: 5)"
      `);
    });

    it('says so in one line when the ticket has no relationship', async () => {
      // What the API sends on an unlinked ticket: an empty followup_ids, a null
      // problem_id and a via.source with no rel.
      serveTicket({
        type: 'question',
        followup_ids: [],
        problem_id: null,
        via: { channel: 'web', source: { from: {}, to: {}, rel: null } },
      });
      expect(await relationsOf(5)).toMatchInlineSnapshot(`
        "# Relationships of ticket #5
        No related tickets: not a follow-up, no follow-ups created from it, not linked to a problem."
      `);
    });

    it('treats a ticket without any relationship field as having none', async () => {
      // MOCK_TICKET carries none of followup_ids, problem_id or via at all.
      serveTicket({});
      expect(await relationsOf(5)).toBe(
        '# Relationships of ticket #5\nNo related tickets: not a follow-up, no follow-ups created from it, not linked to a problem.',
      );
    });

    it("does not read another rel's source ticket as a follow-up", async () => {
      // The Via object reference documents `from.ticket_id` for other rels too
      // (merge, problem); only "follow_up" means this ticket continues that one.
      serveTicket({
        type: 'question',
        via: { channel: 'merge', source: { from: { ticket_id: 7, subject: 'Dup' }, rel: 'merge' } },
      });
      expect(await relationsOf(5)).not.toContain('Follow-up of');
      expect(await relationsOf(5)).toContain('No related tickets');
    });

    it('fetches the ticket once through the Show Ticket endpoint', async () => {
      const paths: string[] = [];
      mswServer.use(
        http.get('https://testsubdomain.zendesk.com/api/v2/tickets/:id', ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json({ ticket: MOCK_TICKET });
        }),
      );
      await tool.handler({ ticket_id: 1 });
      expect(paths).toEqual(['/api/v2/tickets/1']);
    });

    it('rejects with a not-found error for an unknown ticket id', async () => {
      // The shared MSW handler answers /tickets/404 with a 404.
      await expect(tool.handler({ ticket_id: 404 })).rejects.toThrow(/Resource not found/);
    });

    it('is readOnly', () => {
      expect(tool.readOnly).toBe(true);
      expect(tool.namespace).toBe('tickets');
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    });

    it('explains the follow-up case and routes the reverse problem lookup', () => {
      expect(tool.description).toContain('follow-up');
      expect(tool.description).toContain('get_linked_incidents');
      expect(tool.description).toMatch(/read-only/i);
    });

    it('can be enabled on its own with --tool get_ticket_relations', () => {
      const selected = filterTools(createAllTools(ctx), {
        readOnly: true,
        tools: ['get_ticket_relations'],
      });
      expect(selected.map((t) => t.name)).toEqual(['get_ticket_relations']);
    });
  });
});
