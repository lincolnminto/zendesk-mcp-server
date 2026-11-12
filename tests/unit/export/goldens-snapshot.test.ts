import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  buildSearchQueries,
  readLatestTickets,
  stratifiedSample,
} from '../../../src/export/goldens-snapshot';

it('samples round-robin with deterministic strata and descending ids, excluding deleted', () => {
  const tickets = [
    { id: 1, status: 'open' },
    { id: 5, status: 'pending' },
    { id: 4, status: 'open' },
    { id: 3, status: 'deleted' },
    { id: 2, status: 'pending' },
  ];
  expect(stratifiedSample(tickets, 9, (t) => t.status).map((t) => t.id)).toEqual([4, 5, 1, 2]);
  expect(stratifiedSample([...tickets].reverse(), 3, (t) => t.status).map((t) => t.id)).toEqual([
    4, 5, 1,
  ]);
});

it('streams tickets, retaining only the last version and the fields needed for observations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goldens-input-'));
  await writeFile(
    join(dir, 'tickets.ndjson'),
    '{"id":1,"status":"open","description":"large"}\n{"id":2,"status":"pending"}\n{"id":1,"status":"closed"}\n',
  );
  expect(await readLatestTickets(dir)).toEqual([
    { id: 1, status: 'closed' },
    { id: 2, status: 'pending' },
  ]);
});

it('generates stable ticket queries with counted, escaped names and subject terms', () => {
  const stats = {
    tickets: [
      {
        id: 1,
        status: 'open',
        tags: ['z', 'a'],
        group_id: 1,
        assignee_id: 2,
        requester_id: 2,
        organization_id: 3,
        brand_id: 4,
        ticket_form_id: 5,
        subject: 'Cobrança cartão cobrança cartão sobre',
      },
      { id: 2, status: 'closed', tags: ['a'], subject: 'Falha cobrança' },
      { id: 3, status: 'deleted', tags: ['ignored'], subject: 'ignored' },
    ],
    users: [{ id: 2, email: 'agent@example.test' }],
    groups: [{ id: 1, name: 'Team "A"' }],
    organizations: [{ id: 3, name: 'Org' }],
    brands: [{ id: 4, name: 'Brand' }],
    forms: [{ id: 5, name: 'Form' }],
  };
  expect(buildSearchQueries(stats, new Date('2026-01-01T00:00:00Z'))).toMatchInlineSnapshot(`
    [
      {
        "id": "generated-01",
        "query": "type:ticket status:new",
      },
      {
        "id": "generated-02",
        "query": "type:ticket status:open",
      },
      {
        "id": "generated-03",
        "query": "type:ticket status:pending",
      },
      {
        "id": "generated-04",
        "query": "type:ticket status:hold",
      },
      {
        "id": "generated-05",
        "query": "type:ticket status:solved",
      },
      {
        "id": "generated-06",
        "query": "type:ticket status:closed",
      },
      {
        "id": "generated-07",
        "query": "type:ticket status<solved",
      },
      {
        "id": "generated-08",
        "query": "type:ticket priority:urgent",
      },
      {
        "id": "generated-09",
        "query": "type:ticket priority:high",
      },
      {
        "id": "generated-10",
        "query": "type:ticket ticket_type:incident",
      },
      {
        "id": "generated-11",
        "query": "type:ticket ticket_type:problem",
      },
      {
        "id": "generated-12",
        "query": "type:ticket tags:a",
      },
      {
        "id": "generated-13",
        "query": "type:ticket tags:z",
      },
      {
        "id": "generated-14",
        "query": "type:ticket group:"Team \\"A\\""",
      },
      {
        "id": "generated-15",
        "query": "type:ticket assignee:agent@example.test",
      },
      {
        "id": "generated-16",
        "query": "type:ticket requester:agent@example.test",
      },
      {
        "id": "generated-17",
        "query": "type:ticket organization:"Org"",
      },
      {
        "id": "generated-18",
        "query": "type:ticket brand:"Brand"",
      },
      {
        "id": "generated-19",
        "query": "type:ticket form:"Form"",
      },
      {
        "id": "generated-20",
        "query": "type:ticket created>=2025-12-02",
      },
      {
        "id": "generated-21",
        "query": "type:ticket updated<2025-01-01",
      },
      {
        "id": "generated-22",
        "query": "type:ticket solved>=2025-12-02",
      },
      {
        "id": "generated-23",
        "query": "type:ticket status<solved assignee:none",
      },
      {
        "id": "generated-24",
        "query": "type:ticket status:open group:"Team \\"A\\""",
      },
      {
        "id": "generated-25",
        "query": "type:ticket cobrança",
      },
      {
        "id": "generated-26",
        "query": "type:ticket cartão",
      },
      {
        "id": "generated-27",
        "query": "type:ticket falha",
      },
      {
        "id": "generated-28",
        "query": "type:ticket cobranca",
      },
      {
        "id": "generated-29",
        "query": "type:ticket cartao",
      },
      {
        "id": "generated-30",
        "query": "type:ticket "cartão cobrança"",
      },
    ]
  `);
});
