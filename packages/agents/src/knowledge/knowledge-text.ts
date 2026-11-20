import { envelope } from '../model/provider-messages.js';
import type { GraphItem } from './select-knowledge.js';

/**
 * The rule of the knowledge block, outside the envelope (self-learning design-core.md, KD-6; FR-07,
 * AC-07.1–AC-07.3): the graph is a hint where to look, never a source of the answer.
 */
export const KNOWLEDGE_RULE =
  'The knowledge below was learned by earlier runs of this workflow. It is a hint where to look, not a source: ' +
  'confirm every claim of your answer with a call in this run, and never name this knowledge as a source.';

/** Who wrote the enveloped records: the workflow's own earlier runs, through extraction. */
const KNOWLEDGE_AUTHOR = 'earlier runs of this workflow';

/** The record's key in the vector store and in the extraction input: `e12` for an entity, `r7` for a relation. */
export function knowledgeKey(item: Pick<GraphItem, 'type' | 'id'>): string {
  return `${item.type === 'entity' ? 'e' : 'r'}${item.id}`;
}

/** A record's line as a run step sees it, without its id; the size of the record in the selection is this line's. */
export function knowledgeLine(item: GraphItem): string {
  switch (item.type) {
    case 'entity':
      return `${oneLine(item.name)}: ${oneLine(item.description)}`;
    case 'relation':
      switch (item.kind) {
        case 'fact':
          return `${oneLine(item.from.name)} — ${oneLine(item.label)} — ${oneLine(item.to.name)}`;
        case 'lesson':
          return (
            `lesson: ${toolOf(item)} for ${oneLine(item.question)}: ${oneLine(item.hint)} ` +
            `(outcome: ${oneLine(item.outcome)})`
          );
        case 'searched_nothing':
          return `nothing found: ${toolOf(item)} for ${oneLine(item.question)}`;
      }
  }
}

/** A record's line in the extraction input: its key first, so the model can confirm or link it by id. */
export function knowledgeLineWithKey(item: GraphItem): string {
  return `${knowledgeKey(item)} ${knowledgeLine(item)}`;
}

/**
 * The knowledge block of a run step: the rule outside, the chosen records' lines inside
 * `envelope('knowledge', …)`, one per line. `chosen` comes from `selectKnowledge` in the common order,
 * so the same set of records gives the same text byte for byte (DC-9). Nothing chosen — `null`, no block.
 */
export function knowledgeText(chosen: readonly GraphItem[]): string | null {
  if (chosen.length === 0) return null;
  return `${KNOWLEDGE_RULE}\n${envelope('knowledge', KNOWLEDGE_AUTHOR, chosen.map(knowledgeLine).join('\n'))}`;
}

function toolOf(item: { readonly server: string; readonly tool: string }): string {
  return `${item.server}.${item.tool}`;
}

/** A record's text on one line: a line break inside a text would split the record in the block. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
