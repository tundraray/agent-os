import { blockSeed, mulberry32, randomInt, type Random } from './prng';
import { LOG_WEEK } from './versions';

export const TICKET_STATUSES = ['open', 'closed'] as const;
type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Teams with their assignees and mean time to close; the means differ so an average closing time per team is a
 * question with a visible answer.
 */
const TEAMS = {
  payments: { assignees: ['anna.kovacs', 'omar.haddad', 'lena.vogel'], meanCloseHours: 18 },
  checkout: { assignees: ['tom.becker', 'yuki.sato', 'ines.moreau'], meanCloseHours: 30 },
  ledger: { assignees: ['piotr.nowak', 'sara.lindqvist'], meanCloseHours: 12 },
  fraud: { assignees: ['diego.ramos', 'mia.jensen', 'ravi.iyer'], meanCloseHours: 48 },
} as const;
export type TicketTeam = keyof typeof TEAMS;
export const TICKET_TEAMS = Object.keys(TEAMS) as TicketTeam[];
export const TICKET_ASSIGNEES = Object.values(TEAMS).flatMap((team) => team.assignees);

const SUBJECTS = [
  'Provider timeouts during checkout',
  'Late provider responses discarded',
  'Ledger write failed on row lock',
  'Fraud score above threshold for returning customer',
  'Payment stuck in authorize',
  'Duplicate charge reported by customer',
  'Refund not reflected in ledger',
  'Checkout page slow to render',
] as const;

const TRACKER_SEED = 0x7a3c2b1d;
const TICKET_COUNT = 1_200;
const FIRST_TICKET_NUMBER = 1001;
const HOUR_MS = 3_600_000;
const MIN_CLOSE_HOURS = 1;

/**
 * A tracker ticket. `closedAt` is set exactly when `status` is `closed`; a ticket whose close would fall after the log
 * week is still open.
 */
export interface Ticket {
  id: string;
  title: string;
  team: TicketTeam;
  assignee: string;
  status: TicketStatus;
  createdAt: string;
  closedAt: string | null;
}

let tickets: readonly Ticket[] | undefined;

/**
 * Every tracker ticket in creation order. Ticket `i` is a pure function of (tracker seed, `i`), so the set is the same
 * in every process and does not depend on the log dataset version.
 */
export function trackerTickets(): readonly Ticket[] {
  tickets ??= Array.from({ length: TICKET_COUNT }, (_, index) => ticketAt(index));
  return tickets;
}

function ticketAt(index: number): Ticket {
  const random = mulberry32(blockSeed(TRACKER_SEED, index));
  const weekStartMs = Date.parse(LOG_WEEK.start);
  const weekEndMs = Date.parse(LOG_WEEK.end);
  const slotMs = (weekEndMs - weekStartMs) / TICKET_COUNT;
  const team = TICKET_TEAMS[randomInt(random, 0, TICKET_TEAMS.length - 1)];
  const { assignees, meanCloseHours } = TEAMS[team];
  const assignee = assignees[randomInt(random, 0, assignees.length - 1)];
  const createdMs = Math.floor(weekStartMs + index * slotMs + random() * slotMs);
  const closedMs = createdMs + closeHours(random, meanCloseHours) * HOUR_MS;
  const closed = closedMs < weekEndMs;
  return {
    id: `TRK-${FIRST_TICKET_NUMBER + index}`,
    title: SUBJECTS[randomInt(random, 0, SUBJECTS.length - 1)],
    team,
    assignee,
    status: closed ? 'closed' : 'open',
    createdAt: new Date(createdMs).toISOString(),
    closedAt: closed ? new Date(closedMs).toISOString() : null,
  };
}

/** Whole-minute hours to close: a shifted exponential with the team's mean. */
function closeHours(random: Random, meanHours: number): number {
  const hours = MIN_CLOSE_HOURS - Math.log(1 - random()) * (meanHours - MIN_CLOSE_HOURS);
  return Math.round(hours * 60) / 60;
}
