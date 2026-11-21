import { z } from 'zod';
import { pageOf } from '../cursor';
import { TICKET_ASSIGNEES, TICKET_STATUSES, TICKET_TEAMS, trackerTickets } from '../tracker';
import { defineTool } from './fixture-tool';

/** Small pages on purpose: a full summary needs the cursor (AC-01.4, paged search). */
const SEARCH_PAGE_SIZE_MAX = 100;

const SearchTicketsArgsSchema = z.strictObject({
  status: z.enum(TICKET_STATUSES).optional().meta({ title: 'Статус' }),
  team: z.enum(TICKET_TEAMS).optional().meta({ title: 'Команда' }),
  assignee: z.enum(TICKET_ASSIGNEES).optional().meta({ title: 'Исполнитель' }),
  pageSize: z.int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE_MAX).meta({ title: 'Размер страницы' }),
  cursor: z.string().min(1).max(1024).optional().meta({ title: 'Курсор' }),
});

const TicketSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  team: z.enum(TICKET_TEAMS),
  assignee: z.enum(TICKET_ASSIGNEES),
  status: z.enum(TICKET_STATUSES),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
});

const SearchTicketsResultSchema = z.strictObject({
  snapshot: z.string(),
  tickets: z.array(TicketSchema),
  totalMatched: z.int(),
  totalRelation: z.literal('eq'),
  nextCursor: z.string().nullable(),
});

/** Tracker tickets in creation order, a page at a time; every page reports the exact match count. */
export const searchTicketsTool = defineTool({
  name: 'search_tickets',
  title: 'Найти тикеты',
  description:
    'Search tracker tickets with optional status (open, closed), team and assignee filters. ' +
    'Each ticket has id, title, team, assignee, status, createdAt and closedAt (null while open). ' +
    'Returns up to pageSize tickets in creation order; pass nextCursor back as cursor for the next page.',
  readOnly: true,
  argsSchema: SearchTicketsArgsSchema,
  resultSchema: SearchTicketsResultSchema,
  run(args, dataset) {
    const matched = trackerTickets().filter(
      (ticket) =>
        (args.status === undefined || ticket.status === args.status) &&
        (args.team === undefined || ticket.team === args.team) &&
        (args.assignee === undefined || ticket.assignee === args.assignee),
    );
    const page = pageOf(matched, args, dataset);
    if (typeof page === 'string') {
      return page;
    }
    return {
      snapshot: dataset.snapshot,
      tickets: page.items,
      totalMatched: matched.length,
      totalRelation: 'eq',
      nextCursor: page.nextCursor,
    };
  },
});
