import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type RecordRow = Record<string, unknown> & { id: number };
export const pick = (
  row: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, row[key]]));
const TICKET_FIELDS = [
  'id',
  'status',
  'priority',
  'group_id',
  'assignee_id',
  'requester_id',
  'organization_id',
  'ticket_form_id',
  'brand_id',
  'subject',
  'tags',
];

/** Streaming parse; large descriptions/comments never survive the current line. */
export const readRows = async (path: string, fields?: readonly string[]): Promise<RecordRow[]> => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Refuse symlink input files.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const latest = new Map<number, RecordRow>();
  try {
    const lines = createInterface({
      input: handle.createReadStream({ autoClose: false }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as RecordRow;
      if (!Number.isSafeInteger(row.id) || row.id <= 0)
        throw new Error('Invalid snapshot record id');
      latest.set(row.id, (fields ? pick(row, fields) : row) as RecordRow);
    }
  } finally {
    await handle.close();
  }
  return [...latest.values()];
};
export const readLatestTickets = (snapshot: string) =>
  readRows(join(snapshot, 'tickets.ndjson'), TICKET_FIELDS);
const compare = (a: string, b: string) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};
export const stratifiedSample = <T extends { id: number; status?: unknown }>(
  tickets: readonly T[],
  n: number,
  keyOf: (ticket: T) => string,
): T[] => {
  const groups = new Map<string, T[]>();
  for (const ticket of tickets) {
    if (ticket.status === 'deleted') continue;
    const key = keyOf(ticket);
    const group = groups.get(key) ?? [];
    group.push(ticket);
    groups.set(key, group);
  }
  const strata = [...groups]
    .sort(([a, x], [b, y]) => y.length - x.length || compare(a, b))
    .map(([, group]) => group.sort((a, b) => b.id - a.id));
  const result: T[] = [];
  for (let round = 0; result.length < n; round++) {
    let added = false;
    for (const group of strata) {
      const ticket = group[round];
      if (ticket && result.length < n) {
        result.push(ticket);
        added = true;
      }
    }
    if (!added) break;
  }
  return result;
};
export const macroKey = (t: RecordRow) =>
  JSON.stringify([t['status'], t['ticket_form_id'], t['brand_id']]);
export const slaKey = (t: RecordRow) =>
  JSON.stringify([t['status'], t['priority'], t['group_id'], t['ticket_form_id']]);
export const slaSample = (tickets: RecordRow[], n: number) => [
  ...stratifiedSample(
    tickets.filter((t) => t['status'] !== 'closed'),
    n - Math.floor(n * 0.1),
    slaKey,
  ),
  ...stratifiedSample(
    tickets.filter((t) => t['status'] === 'closed'),
    Math.floor(n * 0.1),
    slaKey,
  ),
];
export interface SnapshotStats {
  tickets: RecordRow[];
  users: RecordRow[];
  groups: RecordRow[];
  organizations: RecordRow[];
  brands: RecordRow[];
  forms: RecordRow[];
}
export interface SearchQuery {
  id: string;
  query: string;
}
const STOPWORDS = new Set([
  'sobre',
  'entre',
  'ainda',
  'todos',
  'todas',
  'pelos',
  'pelas',
  'quando',
  'muito',
  'muita',
  'minha',
  'tenho',
  'estou',
  'favor',
  'obrigado',
  'obrigada',
  'preciso',
  'poderia',
  'porque',
  'depois',
  'antes',
  'mesmo',
  'mesma',
  'nosso',
  'nossa',
  'vocês',
]);
const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const ranked = (values: string[][], n: number) => {
  const counts = new Map<string, number>();
  for (const valuesOfTicket of values)
    for (const key of new Set(valuesOfTicket)) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || compare(a, b))
    .slice(0, n)
    .map(([key]) => key);
};
export const buildSearchQueries = (stats: SnapshotStats, now: Date): SearchQuery[] => {
  const tickets = stats.tickets.filter((t) => t['status'] !== 'deleted');
  const terms = [
    'status:new',
    'status:open',
    'status:pending',
    'status:hold',
    'status:solved',
    'status:closed',
    'status<solved',
    'priority:urgent',
    'priority:high',
    'ticket_type:incident',
    'ticket_type:problem',
  ];
  terms.push(
    ...ranked(
      tickets.map((t) => (Array.isArray(t['tags']) ? (t['tags'] as string[]) : [])),
      5,
    ).map((tag) => `tags:${tag}`),
  );
  const names = (field: string, rows: RecordRow[], property: string, count: number) => {
    const lookup = new Map(rows.map((row) => [row.id, row[property]]));
    return ranked(
      tickets.map((t) => {
        const name = lookup.get(t[field] as number);
        return typeof name === 'string' && name ? [name] : [];
      }),
      count,
    );
  };
  const groups = names('group_id', stats.groups, 'name', 4);
  terms.push(...groups.map((name) => `group:${quote(name)}`));
  for (const [field, rows, property, count, prefix, quoted] of [
    ['assignee_id', stats.users, 'email', 4, 'assignee', false],
    ['requester_id', stats.users, 'email', 3, 'requester', false],
    ['organization_id', stats.organizations, 'name', 3, 'organization', true],
    ['brand_id', stats.brands, 'name', 2, 'brand', true],
    ['ticket_form_id', stats.forms, 'name', 2, 'form', true],
  ] as const)
    terms.push(
      ...names(field, rows, property, count).map(
        (name) => `${prefix}:${quoted ? quote(name) : name}`,
      ),
    );
  const date = (days: number) =>
    new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  terms.push(
    `created>=${date(30)}`,
    `updated<${date(365)}`,
    `solved>=${date(30)}`,
    'status<solved assignee:none',
  );
  if (groups[0]) terms.push(`status:open group:${quote(groups[0])}`);
  const words = tickets.map(
    (t) =>
      String(t['subject'] ?? '')
        .toLowerCase()
        .match(/\p{L}{5,}/gu)
        ?.filter((word) => !STOPWORDS.has(word)) ?? [],
  );
  const top = ranked(words, 6);
  terms.push(...top);
  terms.push(
    ...top
      .filter((word) => word.normalize('NFD').replace(/\p{M}/gu, '') !== word)
      .slice(0, 3)
      .map((word) => word.normalize('NFD').replace(/\p{M}/gu, '')),
  );
  const bigram = ranked(
    words.map((list) => list.slice(1).map((word, index) => `${list[index]} ${word}`)),
    1,
  )[0];
  if (bigram) terms.push(quote(bigram));
  return terms.map((term, index) => ({
    id: `generated-${String(index + 1).padStart(2, '0')}`,
    query: `type:ticket ${term}`,
  }));
};
