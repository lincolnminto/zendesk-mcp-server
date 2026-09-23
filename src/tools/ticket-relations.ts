import * as z from 'zod/v4';
import { zendeskGet } from '../client/zendesk-api';
import type { ZendeskTicket } from '../types';
import type { ToolContext, ToolDefinition } from './definitions';

// The relationship fields of a Show Ticket response, typed here rather than on
// the shared ZendeskTicket so this tool stays a self-contained module. Names are
// from the Tickets API (`problem_id`, `followup_ids`) and the Via object
// reference (`via.source.rel`; its "follow_up" value carries the closed source
// ticket as `from.ticket_id` and `from.subject`).
type TicketWithRelations = Pick<ZendeskTicket, 'id' | 'type'> & {
  problem_id?: number | null;
  followup_ids?: number[];
  via?: {
    source?: {
      from?: { ticket_id?: number; subject?: string };
      rel?: string | null;
    };
  };
};

// One line per relationship Zendesk records on the ticket, absent ones omitted.
// Only rel "follow_up" reads `from` as the ticket this one continues: the Via
// object reference documents `from.ticket_id` for other rels too (merge,
// problem), with other meanings.
const formatTicketRelations = (ticket: TicketWithRelations): string => {
  const source = ticket.via?.source;
  const followUpOf = source?.rel === 'follow_up' ? source.from : undefined;
  const followups = ticket.followup_ids ?? [];
  const lines = [
    followUpOf?.ticket_id
      ? `- **Follow-up of**: #${followUpOf.ticket_id}${followUpOf.subject ? ` (${followUpOf.subject})` : ''} — the closed ticket this one continues`
      : '',
    followups.length > 0
      ? `- **Follow-ups**: ${followups.map((id) => `#${id}`).join(', ')} — tickets created from this one after it closed`
      : '',
    ticket.problem_id
      ? `- **Problem**: #${ticket.problem_id} — the problem ticket this incident is linked to`
      : '',
    ticket.type === 'problem'
      ? `- **Incidents**: this is a problem ticket; list the incidents linked to it with get_linked_incidents (problem_id: ${ticket.id})`
      : '',
  ].filter(Boolean);
  return [
    `# Relationships of ticket #${ticket.id}`,
    ...(lines.length > 0
      ? lines
      : [
          'No related tickets: not a follow-up, no follow-ups created from it, not linked to a problem.',
        ]),
  ].join('\n');
};

export const createTicketRelationTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  return [
    {
      name: 'get_ticket_relations',
      namespace: 'tickets',
      readOnly: true,
      title: 'Get Zendesk Ticket Relations',
      description:
        'List the tickets a Zendesk ticket is linked to (the closed ticket it is a follow-up of, the follow-ups created from it, and for an incident its problem ticket) as ticket ids, one line per relationship present. A closed ticket cannot be reopened, so when the customer replies to one Zendesk opens a new follow-up ticket instead and a single issue ends up split across tickets; use this to walk that chain in either direction, then read each ticket with get_ticket. Follow-ups are listed on the original only once it is closed (Zendesk hides them before), and the source ticket subject is shown when Zendesk provides it. For a problem ticket it points to get_linked_incidents, which lists the incidents linked to it; a ticket with none of these relationships returns a line saying so. Merges and side-conversation child tickets are not covered. Read-only: one ticket fetch, nothing is changed; an unknown ticket id returns a not-found error.',
      inputSchema: z.object({
        ticket_id: z
          .number()
          .int()
          .describe(
            'Ticket ID — the numeric id of the ticket whose related tickets to list. Obtain it from search_tickets, list_tickets, or a previous get_ticket_relations result to follow the chain.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id } = params as { ticket_id: number };
        const token = await getToken();
        const { ticket } = await zendeskGet<{ ticket: TicketWithRelations }>(
          subdomain,
          token,
          `/tickets/${ticket_id}`,
        );
        return { content: [{ type: 'text', text: formatTicketRelations(ticket) }] };
      },
    },
  ];
};
