import { McpServerNameSchema } from '@agent-os/contracts';
import { z } from 'zod';

/**
 * The model's tools of an extraction round (self-learning design-core.md, «Внутри платформы»,
 * `record_knowledge` and `choose_entities`; KD-4). The model judges, `checkOperations` decides.
 */

export const RECORD_KNOWLEDGE_TOOL = 'record_knowledge';
export const CHOOSE_ENTITIES_TOOL = 'choose_entities';

/** Operations of one answer beyond this number are rejected with `too_many` by `checkOperations`. */
export const KNOWLEDGE_OPERATIONS_MAX = 50;
/** Length of `name`, `label`, `question`, `outcome` (and of a tool name and a `ref`). */
const KNOWLEDGE_SHORT_TEXT_MAX = 200;
/** Length of `description` and `hint`. */
const KNOWLEDGE_LONG_TEXT_MAX = 500;

/** `e12` — an entity of the graph; `r7` — a relation; `c3` — a tool call of the round's input. */
export const ENTITY_ID_PATTERN = /^e[1-9]\d*$/;
const RELATION_ID_PATTERN = /^r[1-9]\d*$/;
const CALL_ID_PATTERN = /^c[1-9]\d*$/;

const shortText = z.string().trim().min(1).max(KNOWLEDGE_SHORT_TEXT_MAX);
const longText = z.string().trim().min(1).max(KNOWLEDGE_LONG_TEXT_MAX);

const EntityIdSchema = z.string().regex(ENTITY_ID_PATTERN);
const ItemIdSchema = z
  .string()
  .regex(new RegExp(`${ENTITY_ID_PATTERN.source}|${RELATION_ID_PATTERN.source}`))
  .describe('The id of a record of the graph: e… for an entity, r… for a relation');

/** A label of a new entity for references within the same answer; it may not look like an entity id. */
const RefSchema = shortText
  .refine((ref) => !ENTITY_ID_PATTERN.test(ref), 'a ref may not look like an entity id')
  .describe('Your label of the new entity, used by from / to of relations later in this answer');

/** An end of a fact: an entity id `e…` or the `ref` of an entity added earlier in the answer. */
const EndSchema = shortText.describe('An entity id e… or the ref of an entity added earlier in this answer');

const EvidenceSchema = z
  .array(z.string().regex(CALL_ID_PATTERN))
  .min(1)
  .describe('Numbers c… of the tool calls of this run the operation rests on');

const toolFields = {
  server: McpServerNameSchema,
  tool: shortText,
  question: shortText.describe('The kind of question the tool was asked'),
};

export const KnowledgeOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_entity'),
    ref: RefSchema,
    name: shortText,
    description: longText,
    evidence: EvidenceSchema,
  }),
  z.discriminatedUnion('kind', [
    z.object({
      op: z.literal('add_relation'),
      kind: z.literal('fact'),
      from: EndSchema,
      to: EndSchema,
      label: shortText,
      evidence: EvidenceSchema,
    }),
    z.object({
      op: z.literal('add_relation'),
      kind: z.literal('lesson'),
      ...toolFields,
      hint: longText.describe('How to call the tool next time'),
      outcome: shortText.describe('What the call gave'),
      evidence: EvidenceSchema,
    }),
    z.object({
      op: z.literal('add_relation'),
      kind: z.literal('searched_nothing'),
      ...toolFields,
      evidence: EvidenceSchema,
    }),
  ]),
  z.object({ op: z.literal('confirm'), id: ItemIdSchema, evidence: EvidenceSchema }),
  z.object({ op: z.literal('mark_outdated'), id: ItemIdSchema }),
]);
export type KnowledgeOperation = z.infer<typeof KnowledgeOperationSchema>;

/**
 * The schema of `record_knowledge` the model sees. The call is parsed with
 * `RecordKnowledgeAnswerSchema` instead: each operation is checked on its own by `checkOperations`, so
 * one malformed operation or a 51st does not void the answer (DC-6).
 */
export const RecordKnowledgeArgsSchema = z.object({
  operations: z
    .array(KnowledgeOperationSchema)
    .describe(`Up to ${KNOWLEDGE_OPERATIONS_MAX} operations on the knowledge graph`),
});

/** How a `record_knowledge` call is parsed: the operations as they are. */
export const RecordKnowledgeAnswerSchema = z.object({ operations: z.array(z.unknown()) });

/** Arguments of `choose_entities`: for each new entity, a candidate's id or `null` to keep it new. */
export const ChooseEntitiesArgsSchema = z.object({
  choices: z.array(
    z.object({
      ref: z.string(),
      id: EntityIdSchema.nullable().describe('The id e… of the chosen candidate, or null to keep the entity new'),
    }),
  ),
});
export type ChooseEntitiesArgs = z.infer<typeof ChooseEntitiesArgsSchema>;
