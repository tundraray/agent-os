import { sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  MatchPlaceSchema,
  START_AGENT_TOOL,
  START_DEEP_AGENT_TOOL,
  TASK_TOOL,
} from '@agent-os/contracts';
import type { Db } from '../db';
import {
  agents,
  agentVersions,
  conversations,
  messages,
  messageText,
  runtimeTasks,
  SEARCHED_MESSAGE_KINDS,
  toolResults,
} from '../schema';
import {
  isOneOf,
  literal,
  SEARCH_CONFIG,
  searchedText,
  searchVector,
} from '../schema/helpers';

/** Position of a found place in the search order: its time in ms and its place key. */
export interface SearchPosition {
  readonly at: Date;
  readonly key: string;
}

export interface ConversationSearchInput {
  readonly ownerId: string;
  /** The text of the search field; parsed into words by Postgres, never spliced into SQL. */
  readonly query: string;
  /** The last place of the previous page; absent for the first page. */
  readonly after?: SearchPosition;
  /** Places of the page; one more row is read to tell whether a next page exists. */
  readonly limit: number;
}

/**
 * One found place. `at` is ISO with ms; `headline` is the fragment of `ts_headline` with the found words
 * between U+0001 and U+0002 (the whole title for `place: title`), `null` on the extra row past `limit`;
 * `continuesBefore`/`continuesAfter` — the text goes on before or after the fragment.
 */
export type ConversationSearchRow = {
  readonly key: string;
  readonly at: string;
  readonly place: string;
  readonly rootId: string;
  /** The root's title; `''` until one is written. */
  readonly rootTitle: string;
  readonly conversationId: string;
  /** The conversation of the place has a parent: a sub-agent's. */
  readonly subagent: boolean;
  /**
   * The agent of the conversation of the place as the agent screens name it: the team member of a subagent run,
   * otherwise the name of the library record it started on (`conversations.name` may hold a record id).
   */
  readonly name: string;
  readonly seq: number | null;
  readonly callId: string | null;
  readonly tool: string | null;
  readonly headline: string | null;
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
};

/** Start sel and stop sel of `ts_headline`: control characters, so a `<b>` of the text stays text. */
const MARKS = 'StartSel=\u0001, StopSel=\u0002';
const TITLE_OPTIONS = `${MARKS}, HighlightAll=true`;
/** One fragment: the default cover can start inside a hyphenated word (`provider-adapter` from `adapter`). */
const TEXT_OPTIONS = `${MARKS}, MaxFragments=1`;

/** Results whose text is a sub-agent's report, found in its own conversation (KD-3). */
const START_TOOLS = [START_AGENT_TOOL, START_DEEP_AGENT_TOOL, TASK_TOOL];
const { title, message, tool_result: toolResult } = MatchPlaceSchema.enum;

const place = alias(conversations, 'place');
const root = alias(conversations, 'root');
const task = alias(runtimeTasks, 'task');
const entry = alias(messages, 'entry');
const record = alias(messages, 'record');
const result = alias(toolResults, 'result');

/** The time of a place in the search order: the cursor keeps ms. */
const atMs = (column: AnyPgColumn): SQL =>
  sql`date_trunc('milliseconds', ${column})`;

/**
 * Full text search over the employee's live conversations (conversation-search KD-1 – KD-6): conversation
 * titles, history entries and stored tool results, each found by its own index expression.
 */
export class ConversationSearchRepository {
  constructor(private readonly db: Db) {}

  /**
   * The owner's found places after `after`, newest first, `limit + 1` rows; the fragment is built for the
   * first `limit` only. One query: a query without a searched word (only stop words) gives a null tsquery,
   * which matches nothing.
   */
  async search(
    input: ConversationSearchInput,
  ): Promise<ConversationSearchRow[]> {
    const result = await this.db.client.execute<ConversationSearchRow>(
      this.pageQuery(input),
    );
    return result.rows;
  }

  /**
   * `found` and `page` carry only the position and ids of a place; its text is read again for the page rows
   * alone (`entry_seq` names the history entry, `null` for a title or a stored result).
   */
  private pageQuery(input: ConversationSearchInput): SQL {
    /** A scalar subquery: an init plan the planner takes as a constant of each index scan. */
    const query = sql`(select words.query from words)`;
    const live = sql`${task.taskId} = ${place.id} and ${task.deletedAt} is null and ${place.ownerId} = ${input.ownerId}`;
    /** A built-in start tool (an MCP tool of the same name has a server and is searched). */
    const notStartTool = (content: AnyPgColumn) =>
      sql`not ((${content} ->> 'server') is null and (${content} ->> 'tool') in (${sql.join(START_TOOLS.map(literal), sql`, `)}))`;
    const after = input.after
      ? sql`where found.at < ${input.after.at.toISOString()}::timestamptz
          or (found.at = ${input.after.at.toISOString()}::timestamptz and found.key collate "C" < ${input.after.key})`
      : sql``;
    return sql`
      with words as (
        select string_agg('''' || replace(replace(lexeme, '\\', '\\\\'), '''', '''''') || ''':*', ' & ')::tsquery
          as query
        from unnest(to_tsvector(${SEARCH_CONFIG}, ${input.query}))
      ),
      found as (
        select 't:' || ${place.id} as key, ${atMs(place.updatedAt)} as at, ${literal(title)} as place,
          ${place.id} as conversation_id, null::integer as seq, null::text as call_id, null::text as tool,
          null::integer as entry_seq, ${task.rootId} as root_id
        from ${conversations} ${place}, ${runtimeTasks} ${task}
        where ${searchVector(place.title)} @@ ${query} and ${place.parentId} IS NULL and ${live}
        union all
        select case when ${entry.kind} = ${literal(toolResult)}
            then 'r:' || ${entry.conversationId} || ':' || ${entry.callId}
            else 'm:' || ${entry.conversationId} || ':' || lpad(${entry.seq}::text, 10, '0') end,
          ${atMs(entry.createdAt)},
          case when ${entry.kind} = ${literal(toolResult)} then ${literal(toolResult)} else ${literal(message)} end,
          ${entry.conversationId}, case when ${entry.kind} <> ${literal(toolResult)} then ${entry.seq} end,
          ${entry.callId}, ${entry.content} ->> 'tool', ${entry.seq}, ${task.rootId}
        from ${messages} ${entry}, ${conversations} ${place}, ${runtimeTasks} ${task}
        where ${searchVector(messageText(entry.content))} @@ ${query}
          and ${isOneOf(entry.kind, SEARCHED_MESSAGE_KINDS)}
          and ${place.id} = ${entry.conversationId} and ${live}
          and (${entry.kind} <> ${literal(toolResult)} or (${notStartTool(entry.content)} and not exists (
            select 1 from ${toolResults} ${result}
            where ${result.conversationId} = ${entry.conversationId} and ${result.callId} = ${entry.callId})))
        union all
        select 'r:' || ${result.conversationId} || ':' || ${result.callId}, ${atMs(result.createdAt)},
          ${literal(toolResult)}, ${result.conversationId}, null, ${result.callId}, ${record.content} ->> 'tool',
          null, ${task.rootId}
        from ${toolResults} ${result}, ${messages} ${record}, ${conversations} ${place},
          ${runtimeTasks} ${task}
        where ${searchVector(result.text)} @@ ${query}
          and ${record.conversationId} = ${result.conversationId} and ${record.callId} = ${result.callId}
          and ${record.kind} = ${literal(toolResult)} and ${notStartTool(record.content)}
          and ${place.id} = ${result.conversationId} and ${live}
      ),
      page as (
        select found.*, row_number() over (order by found.at desc, found.key collate "C" desc) as n
        from found ${after}
        order by found.at desc, found.key collate "C" desc
        limit ${input.limit + 1}
      )
      select page.key, to_char(page.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
        page.place, page.root_id as "rootId", ${root.title} as "rootTitle",
        page.conversation_id as "conversationId", ${place.parentId} is not null as subagent,
        coalesce(${place.subagent}, ${agents.name}) as name,
        page.seq, page.call_id as "callId", page.tool, fragment.headline,
        coalesce(fragment.found_at <> 1, false) as "continuesBefore",
        coalesce(fragment.found_at = 0 or fragment.found_at + length(fragment.plain) - 1 < length(source.text), false)
          as "continuesAfter"
      from page
      join ${conversations} ${place} on ${place.id} = page.conversation_id
      join ${conversations} ${root} on ${root.id} = page.root_id
      join ${agentVersions} on ${agentVersions.id} = ${place.agentVersionId}
      join ${agents} on ${agents.id} = ${agentVersions.agentId}
      left join ${messages} ${entry}
        on ${entry.conversationId} = page.conversation_id and ${entry.seq} = page.entry_seq
      left join ${toolResults} ${result} on page.entry_seq is null
        and ${result.conversationId} = page.conversation_id and ${result.callId} = page.call_id
      cross join lateral (
        select case when page.place = ${literal(title)} then ${place.title}
          when page.entry_seq is not null then ${messageText(entry.content)}
          else ${result.text} end as text
      ) source
      cross join lateral (
        select headline, strpos(${searchedText(sql`source.text`)}, plain) as found_at, plain
        from (
          select headline, replace(replace(headline, chr(1), ''), chr(2), '') as plain
          from (
            select case when page.n <= ${input.limit} then ts_headline(${SEARCH_CONFIG}, ${searchedText(sql`source.text`)}, ${query},
              case when page.place = ${literal(title)} then ${TITLE_OPTIONS} else ${TEXT_OPTIONS} end) end as headline
          ) built
        ) stripped
      ) fragment
      order by page.at desc, page.key collate "C" desc`;
  }
}
